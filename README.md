# AO 工具链

Agent Orchestrator（AO）的本地运维工具。**和任何业务项目无关**，独立于 CloverStart 等仓库。

## 这套工具解决什么

多 agent 并行干活时会出现工作区与会话污染：会话堆积、孤儿 worktree、分支不清理、
任务该派给谁全靠人拍脑袋、各 agent 之间不知道对方做了什么。

## 组成

| 文件 | 作用 |
|---|---|
| `ao-config.js` | **配置解析（所有脚本都依赖它）** |
| `ao-control.js` | 会话管控：配额、回收、孤儿检测、健康报告 |
| `ao-dispatch.js` | 任务分配：关键词粗筛 + 语义兜底 |
| `ao-dispatch.rules.json` | 分配规则表（改这里不用改代码） |
| `sync-mcp.js` | 把共享上下文 MCP 写进各 agent 配置 |
| `context-mcp/` | 共享上下文 MCP server（7 个工具） |
| `semantic-router/` | 语义路由服务（FastAPI + bge-small-zh） |

## 配置解析（方案 C：四层兜底）

`ao-config.js` 按以下优先级解析仓库根和项目名：

```
1. 环境变量        AO_REPO / AO_PROJECT / AO_CONTEXT_DIR
2. 配置文件        ~/.ao/config.json
3. git 自动探测    git rev-parse --show-toplevel（从 cwd 向上找）
4. 当前目录        process.cwd()
```

**换项目**：设 `AO_PROJECT`，或在 `~/.ao/config.json` 里登记。
**换电脑**：什么都不用配，第 3 层会自动认当前仓库。

配置文件格式（可选）：

```json
{
  "defaultProject": "cloverstart",
  "projects": {
    "cloverstart": { "repo": "E:\\CloverStart" }
  }
}
```

## 常用命令

> **必须在业务项目目录下运行，不能在 `~\.ao\tools` 里运行。**
> `tools` 自己也是一个 git 仓库，`ao-config.js` 第 3 层 `git rev-parse` 会把当前仓库误认成 `tools`，
> 于是所有操作都打到工具链自己身上。

```powershell
# ✅ 正确：先进入业务项目
cd E:\YourProject
node ~\.ao\tools\ao-control.js status

# ❌ 错误：在工具链目录里运行
cd ~\.ao\tools
node ao-control.js status        # 会把 ~/.ao/tools 当成业务项目
```

```powershell
# 健康报告
node ~\.ao\tools\ao-control.js status

# 清理（先预览，确认后加 --apply）
node ~\.ao\tools\ao-control.js enforce
node ~\.ao\tools\ao-control.js enforce --apply

# 问该派给谁
node ~\.ao\tools\ao-dispatch.js plan "帮我修个 bug"

# 实际派活（先 --dry-run 看命令）
node ~\.ao\tools\ao-dispatch.js run --dry-run "任务描述"
node ~\.ao\tools\ao-dispatch.js run "任务描述"

# 同步 MCP 配置到各 agent
node ~\.ao\tools\sync-mcp.js --dry-run
node ~\.ao\tools\sync-mcp.js
```

## 语义路由服务

```powershell
# 手动启动
cd ~\.ao\tools\semantic-router
uv run server.py

# 开机自启
powershell -NoProfile -ExecutionPolicy Bypass -File ~\.ao\tools\semantic-router\install-autostart.ps1
```

健康检查：`http://127.0.0.1:8765/health`

不启动也不影响分配 —— `ao-dispatch.js` 会自动降级到关键词层。

## 前置条件

| 依赖 | 用途 | 缺失后果 |
|---|---|---|
| AO 桌面端 | 提供 ao.exe，ao-control.js / ao-dispatch.js 全靠它 | 两个脚本完全不可用 |
| Node.js >= 18 | 运行所有 .js 脚本 | 全部脚本不可用 |
| uv | 建语义路由的 Python 环境 | 只能关键词匹配，无语义兜底 |
| DSH 或 Codex | sync-mcp.js 的写入目标 | 无对象可写 |

`ao.exe` 默认在 `%LOCALAPPDATA%\Programs\agent-orchestrator\resources\daemon\ao.exe`。
装在别处时用 `AO_BIN` 环境变量指向实际路径，例如：

```powershell
$env:AO_BIN = 'D:\Apps\agent-orchestrator\resources\daemon\ao.exe'
```

（解析逻辑见 `ao-config.js` 的 `resolveAoBin()`：`AO_BIN` 优先，且要求文件真实存在，否则回退默认位置。）

## 首次部署（新电脑）

仓库地址：**https://github.com/zhongyi0102/ao-tools**（**private**）

```powershell
git clone https://github.com/zhongyi0102/ao-tools.git $env:USERPROFILE\.ao\tools
cd $env:USERPROFILE\.ao\tools
```

> **仓库是 private**：别人 `clone` 前必须让 `zhongyi0102` 把自己的 GitHub 账号加进仓库协作者，
> 或者用有 `repo` scope 的 PAT 克隆：
>
> ```powershell
> git clone https://<你的用户名>:<PAT>@github.com/zhongyi0102/ao-tools.git $env:USERPROFILE\.ao\tools
> ```
>
> 没有访问权限时 `git clone` 会报 `Repository not found` —— 这是权限问题，不是地址写错。

克隆下来只是拿到源码，还差两个可选依赖：

```powershell
cd $env:USERPROFILE\.ao\tools

# 1) MCP server 的 Node 依赖（不装则 ao-context MCP 起不来）
cd context-mcp
npm install
cd ..

# 2) 语义路由的 Python 环境（不装则只能走关键词层）
cd semantic-router
uv venv .venv --python 3.13
uv pip install -r requirements.txt
```

两个依赖都是可选的，但缺了会降级：

| 缺什么 | 后果 |
|---|---|
| `context-mcp/node_modules` | ao-context MCP 启动失败（`MODULE_NOT_FOUND`） |
| `semantic-router/.venv` | 只能关键词匹配，语义兜底不可用 |

`ao-control.js` / `ao-dispatch.js` 本身零依赖，克隆下来直接能跑。

## 硬性约束

**Codex 不尊重 AO 的 worktree**（app-server 无 `-C` 参数）。
所以 `ao-dispatch.rules.json` 里所有 `needsWrite: true` 的规则一律排除 Codex。
改规则时不要破坏这条。
