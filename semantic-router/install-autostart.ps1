# AO 语义路由服务 · 开机自启（用户级，无需管理员）
#
# 用 Windows 启动文件夹放一个 .lnk 快捷方式，登录时用 pythonw.exe 静默启动服务（无黑窗）。
# 不用 .vbs：VBScript 在 Win11 26200 已进入弃用流程（事件 VBScriptDeprecationAlert 4096），
# 而且 pythonw 本身就没有控制台窗口，不需要 wscript 中转。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\semantic-router\install-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\semantic-router\install-autostart.ps1 -Uninstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\semantic-router\install-autostart.ps1 -Status

param(
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$ServerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerPy = Join-Path $ServerDir 'server.py'
$LauncherPy = Join-Path $ServerDir 'run_hidden.pyw'
$VenvDir = Join-Path $ServerDir '.venv'
$PythonwExe = Join-Path $VenvDir 'Scripts\pythonw.exe'
$StartupDir = [Environment]::GetFolderPath('Startup')
$LnkPath = Join-Path $StartupDir 'AO-SemanticRouter.lnk'
# 旧版（wscript + .vbs）残留，仅用于清理
$LegacyVbsPath = Join-Path $StartupDir 'AO-SemanticRouter.vbs'
$LogPath = Join-Path $env:TEMP 'ao-semantic-router.log'

# ---------- 工具函数 ----------
# 停掉占用 8765 的路由服务进程。
# python.exe（uv run）和 pythonw.exe（.lnk 直启）都要认，否则换了启动方式就停不掉旧实例。
function Stop-RouterService {
    $conn = Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
    if (-not $conn) { return $false }
    $stopped = $false
    $procIds = $conn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -and @('python', 'pythonw') -contains $p.ProcessName) {
            Stop-Process -Id $p.Id -Force
            Write-Host "已停止旧服务 PID $($p.Id)（$($p.ProcessName)）" -ForegroundColor Green
            $stopped = $true
        }
    }
    return $stopped
}

# uv 缺失时的可操作提示
function Write-UvMissingHelp {
    Write-Host "找不到 uv。" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "uv 是什么：" -ForegroundColor Cyan
    Write-Host "  它负责建 semantic-router 的 Python 环境（FastAPI + bge-small-zh 向量模型），"
    Write-Host "  语义路由服务就靠这个环境跑起来。"
    Write-Host ""
    Write-Host "不装会怎样：" -ForegroundColor Cyan
    Write-Host "  ao-dispatch.js 只能走关键词粗筛，语义兜底不可用；"
    Write-Host "  但工具链其余部分（ao-control.js / ao-dispatch.js / sync-mcp.js）照常可用。"
    Write-Host ""
    Write-Host "怎么装（任选一条）：" -ForegroundColor Cyan
    Write-Host "  winget install astral-sh.uv"
    Write-Host "  irm https://astral.sh/uv/install.ps1 | iex"
    Write-Host ""
    Write-Host "已经手动建好 .venv 的话不用再装 uv，直接复用现有环境即可。" -ForegroundColor Cyan
    Write-Host "  期望路径: $VenvDir"
    Write-Host ""
}

# ---------- Status ----------
if ($Status) {
    if (Test-Path $LnkPath) {
        Write-Host "自启项已安装: $LnkPath" -ForegroundColor Green
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($LnkPath)
        Write-Host "--- 快捷方式 ---"
        Write-Host "目标    : $($sc.TargetPath)"
        Write-Host "参数    : $($sc.Arguments)"
        Write-Host "工作目录: $($sc.WorkingDirectory)"
        if (-not (Test-Path $sc.TargetPath)) {
            Write-Host "WARN 目标文件不存在（venv 被删了？重跑一次本脚本可修复）" -ForegroundColor Yellow
        }
        Write-Host "----------------"
    } else {
        Write-Host "自启项未安装（$LnkPath 不存在）" -ForegroundColor Yellow
    }

    if (Test-Path $LegacyVbsPath) {
        Write-Host "WARN 发现旧版 .vbs 残留（VBScript 已弃用），-Uninstall 会一并清理: $LegacyVbsPath" -ForegroundColor Yellow
    }

    Write-Host ""
    try {
        $r = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 3
        Write-Host "服务状态: 在线 (模型 $($r.model), $($r.routes.Count) 条路由)" -ForegroundColor Green
    } catch {
        Write-Host "服务状态: 离线" -ForegroundColor Yellow
    }
    exit 0
}

# ---------- Uninstall ----------
if ($Uninstall) {
    $removed = $false
    if (Test-Path $LnkPath) {
        Remove-Item $LnkPath -Force
        Write-Host "已删除自启项: $LnkPath" -ForegroundColor Green
        $removed = $true
    }
    # 兼容旧版安装
    if (Test-Path $LegacyVbsPath) {
        Remove-Item $LegacyVbsPath -Force
        Write-Host "已删除旧版自启项: $LegacyVbsPath" -ForegroundColor Green
        $removed = $true
    }
    if (-not $removed) {
        Write-Host "自启项不存在" -ForegroundColor Yellow
    }

    $null = Stop-RouterService
    exit 0
}

# ---------- Install ----------
Write-Host "=== 安装 AO 语义路由开机自启（用户级）===" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $ServerPy)) {
    throw "找不到 server.py: $ServerPy"
}
if (-not (Test-Path $LauncherPy)) {
    throw "找不到 run_hidden.pyw: $LauncherPy（自启项需要它做无窗口启动）"
}

$uv = Get-Command uv -ErrorAction SilentlyContinue
$venvExists = Test-Path $VenvDir

$uvDisplay = if ($uv) { $uv.Source } elseif ($venvExists) { '未安装（复用已有 venv）' } else { '未安装' }
Write-Host "uv       : $uvDisplay"
Write-Host "服务目录 : $ServerDir"
Write-Host "Python   : $PythonwExe"
Write-Host "启动目录 : $StartupDir"
Write-Host "日志     : $LogPath"
Write-Host ""

# 依赖检查：venv 已在就跳过 uv sync，只有「venv 不在 + uv 不在」才是真阻塞
if (-not $venvExists) {
    if (-not $uv) {
        Write-UvMissingHelp
        throw "缺少 Python 环境：$VenvDir 不存在，且找不到 uv，无法自动创建。请按上面的提示二选一后重试。"
    }
    Write-Host "首次安装需要下载依赖（含 torch，约 2GB）。" -ForegroundColor Yellow
    Write-Host "按 Enter 继续，Ctrl+C 取消"
    Read-Host | Out-Null
    Push-Location $ServerDir
    try {
        & uv sync
        if ($LASTEXITCODE -ne 0) { throw "uv sync 失败" }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $VenvDir)) {
        throw "uv sync 结束但 $VenvDir 仍不存在，请手动检查。"
    }
} elseif (-not $uv) {
    Write-Host "注意：没装 uv，但 $VenvDir 已存在，直接复用它，跳过 uv sync。" -ForegroundColor Yellow
    Write-Host ""
}

if (-not (Test-Path $PythonwExe)) {
    Write-UvMissingHelp
    throw "找不到 pythonw.exe: $PythonwExe。请重建 venv：cd `"$ServerDir`" ; uv venv .venv --python 3.13 ; uv pip install -r requirements.txt"
}

# 生成 .lnk 快捷方式（pythonw 无控制台窗口，不需要 wscript）
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($LnkPath)
$sc.TargetPath = $PythonwExe
$sc.Arguments = "`"$LauncherPy`""
$sc.WorkingDirectory = $ServerDir
$sc.WindowStyle = 7
$sc.Description = 'AO 语义路由服务（pythonw 无窗口）'
$sc.IconLocation = "$PythonwExe,0"
$sc.Save()
Write-Host "OK 已写入自启项: $LnkPath" -ForegroundColor Green
if (Test-Path $LegacyVbsPath) {
    Write-Host "提示：发现旧版 $LegacyVbsPath（VBScript 已弃用），可直接删除；跑 -Uninstall 会一并清理它。" -ForegroundColor Yellow
}

# 立即启动一次验证（先停旧的）
if (Stop-RouterService) {
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "立即启动并等待就绪..."
Start-Process -FilePath $PythonwExe -ArgumentList "`"$LauncherPy`"" -WorkingDirectory $ServerDir | Out-Null

$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 2
        Write-Host "OK 服务就绪（模型 $($r.model)，$($r.routes.Count) 条路由）" -ForegroundColor Green
        $ready = $true
        break
    } catch { }
}

if (-not $ready) {
    Write-Host "WARN 90 秒内未就绪，检查日志: $LogPath" -ForegroundColor Yellow
    if (Test-Path $LogPath) {
        Write-Host "--- 日志尾部 ---"
        Get-Content $LogPath -Tail 20
    }
}

Write-Host ""
Write-Host "后续操作："
Write-Host "  查看状态: powershell -File tools\semantic-router\install-autostart.ps1 -Status"
Write-Host "  卸载:     powershell -File tools\semantic-router\install-autostart.ps1 -Uninstall"
Write-Host ""
