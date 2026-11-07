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

## 首次部署（新电脑）

```powershell
git clone <本仓库> ~\.ao\tools

# 语义路由需要 Python 环境
cd ~\.ao\tools\semantic-router
uv venv .venv --python 3.13
uv pip install -r requirements.txt
```

Node 侧无依赖，直接可跑。

## 硬性约束

**Codex 不尊重 AO 的 worktree**（app-server 无 `-C` 参数）。
所以 `ao-dispatch.rules.json` 里所有 `needsWrite: true` 的规则一律排除 Codex。
改规则时不要破坏这条。
