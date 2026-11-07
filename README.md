# AO 工具链

Agent Orchestrator（AO）的本地运维工具。**和任何业务项目无关**，独立于 CloverStart 等仓库。

> 这是个人自用的 agent 工作流工具链，公开出来仅供**参考**。
> 里面的路径、agent 名称、模型档位都按我本机的环境写死，**不保证对他人环境的适配**，
> 拿去用之前请按自己的环境改。

## 这套工具解决什么

多 agent 并行干活时会出现工作区与会话污染：会话堆积、孤儿 worktree、分支不清理、
任务该派给谁全靠人拍脑袋、各 agent 之间不知道对方做了什么。

## 组成

| 文件 | 作用 |
|---|---|
| `ao-config.js` | **配置解析（所有脚本都依赖它）** |
| `ao-control.js` | 会话管控：配额、回收、孤儿检测、健康报告 |
| `ao-dispatch.js` | 任务分配：关键词粗筛 + 语义兜底 + 两阶段协作 + 派活审计 |
| `ao-dispatch.rules.json` | 分配规则表（改这里不用改代码） |
| `sync-mcp.js` | 把共享上下文 MCP 写进各 agent 配置 |
| `context-mcp/` | 共享上下文 MCP server（7 个工具） |
| `semantic-router/` | 语义路由服务（FastAPI + bge-small-zh） |
| `codex-cwd-proxy.js` | Codex 的 cwd 注入探针（**默认不用**，见下） |

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

### 管控

```powershell
# 健康报告
node ~\.ao\tools\ao-control.js status

# 清理（先预览，确认后加 --apply）
node ~\.ao\tools\ao-control.js enforce
node ~\.ao\tools\ao-control.js enforce --apply
```

### 分配

```powershell
# 问该派给谁（只看决策，不派活）
node ~\.ao\tools\ao-dispatch.js plan "帮我修个 bug"

# 看规则表（含 steer 能力矩阵）
node ~\.ao\tools\ao-dispatch.js rules

# 实际派活（先 --dry-run 看命令）
node ~\.ao\tools\ao-dispatch.js run --dry-run "任务描述"
node ~\.ao\tools\ao-dispatch.js run "任务描述"
```

### 向已有会话发消息

```powershell
# 自动判断：idle → 直接开新一轮；working → 按 agent 能力决定插话还是排队
node ~\.ao\tools\ao-dispatch.js chat <会话id> "补充说明"

# 只看会做什么
node ~\.ao\tools\ao-dispatch.js chat <会话id> "..." --dry-run
```

### 派活审计

```powershell
# 最近 1 天的派活记录（WAL 日志，落在 ~/.ao/logs/dispatch）
node ~\.ao\tools\ao-dispatch.js audit
```

### 同步 MCP 配置

```powershell
node ~\.ao\tools\sync-mcp.js --dry-run
node ~\.ao\tools\sync-mcp.js
```

## 分配规则

规则全在 `ao-dispatch.rules.json`，改它不用改代码。按 `priority` 从小到大匹配，命中即停。

| pri | 规则 | 目标 | 写文件 | 行为 |
|---|---|---|---|---|
| 5 | `escalate` | Codex | ✅ | DSH 卡住时升级给 Codex 接手 |
| 10 | `image` | Codex | — | 带图片（DSH 当前配置不支持图片输入） |
| 15 | `plan-first` | Codex | — | 复杂任务先出方案，再交 DSH 执行 |
| 18 | `review` | Codex | — | 代码审查 |
| 20 | `hard` | Codex | ✅ | 困难任务直接做 |
| 25 | `investigate-deep` | Codex | — | 深度调查（根因/溯源/排查） |
| 40 | `investigate-simple` | DSH | — | 简单调查（便宜） |
| 50 | `docs` | DSH | ✅ | 文档 |
| 60 | `test` | DSH | ✅ | 测试 |
| 70 | `refactor` | DSH | ✅ | 重构 |
| 80 | `code` | DSH | ✅ | 写代码 |

### 两阶段协作（`plan-first`）

命中 `plan-first` 时：

1. **阶段 1**：Codex 只出方案（强制只读措辞），不改任何文件
2. **阶段 2**：DSH 按方案动手

默认只派阶段 1，你看完方案再手动进阶段 2。加 `--wait` 会自动串行执行两阶段：

```powershell
# 只派阶段 1，稍后手动执行
node ~\.ao\tools\ao-dispatch.js run "重构整个项目的错误处理架构"

# 自动串行两阶段
node ~\.ao\tools\ao-dispatch.js run --wait "重构整个项目的错误处理架构"
```

### 升级（`escalate`）

DSH 反复失败或明确做不了时，任务描述里带上触发词，会直接派 Codex 接手：

```powershell
node ~\.ao\tools\ao-dispatch.js run "dsh 做不了这个，升级给 codex 接手：<具体任务>"
```

触发词：`dsh 做不了` / `dsh 卡住` / `dsh 失败` / `升级给` / `接手` / `escalate` / `多次失败`。

### 模型饱和自动降级

腾讯积分等上游会周期性返回 `14003 model busy`（模型繁忙）。
`ao-dispatch.js` 识别这类错误后**自动换下一个模型重试**，不中断流程：

```
尝试 1/2：["jethub","workbuddy/deepseek-v4.1-flash-sg"]
   ⚠️  上游饱和，降级到下一个模型…
尝试 2/2：["jethub","buddy/deepseek-v4-flash"]
✅ 成功
```

非饱和错误（配置错、认证失败）不会重试，直接报错。

## 语义路由服务

```powershell
# 手动启动
cd ~\.ao\tools\semantic-router
uv run server.py

# 开机自启
powershell -NoProfile -ExecutionPolicy Bypass -File ~\.ao\tools\semantic-router\install-autostart.ps1
```

健康检查：`http://127.0.0.1:8765/health`

**按需自启**：`ao-dispatch.js` 探测到服务未运行时会自动拉起（冷启动约 13 秒），
所以你不需要手动启动它。开机自启只是为了避免每次冷启动等待。

不启动也不影响分配 —— `ao-dispatch.js` 会自动降级到关键词层。

## Agent 能力矩阵

`rules.json` 的 `agents` 段记录每个 agent 的能力，决策时据此筛选：

| 字段 | 含义 |
|---|---|
| `enabled` | false 则不参与分配 |
| `respectsWorktree` | 是否遵守 AO 传的 worktree（决定能否写文件） |
| `steerWhileWorking` | 干活中途能否插话（false 时消息排队） |
| `costTier` | 1=便宜 2=中 3=贵 |
| `models` | 模型档位（cheap / normal / strong） |

查看当前矩阵：`node ~\.ao\tools\ao-dispatch.js rules`

### steer 能力（干活中途插话）

| Agent | 支持 | 依据 |
|---|---|---|
| Codex | ✅ | app-server 支持 steering |
| DeepSeek Harness | ❌ | ACP `sessionCapabilities` 只有 `close`/`list`/`resume`，无 steer |

**不支持时**：`ao send --steer` 会报 `CHAT_STEER_UNSUPPORTED`，
消息只能排队（界面显示 `Queued`），当前 turn 结束后自动处理。
想立刻生效，先在界面点 ⏹ 停掉当前 turn。

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

仓库地址：**https://github.com/zhongyi0102/ao-tools**（**public**，直接 clone 即可）

```powershell
git clone https://github.com/zhongyi0102/ao-tools.git $env:USERPROFILE\.ao\tools
cd $env:USERPROFILE\.ao\tools
```

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

## 关于 Codex 的 worktree（重要修正）

**旧版本的 README 写着「Codex 不尊重 AO 的 worktree」，这是错的，已实测推翻。**

实测过程：

```
派 codex 改 README.md →
  实际改动：C:\Users\<user>\.ao\data\worktrees\<project>\<session>\README.md
  主仓库   ：MD5 未变，git status 干净
```

原因：AO 确实通过 codex 的 `thread/start` 协议传了 `cwd`
（`ThreadStartParams.json` 里有该字段），**不需要 `-C` 命令行参数** ——
`app-server` 是长驻 JSON-RPC 服务，参数走协议而不是命令行。

所以 `rules.json` 里 Codex 的 `respectsWorktree` 已改为 `true`，
`hard` 规则允许它写文件。

`codex-cwd-proxy.js` 是当初为验证这件事写的探针，实测证明 AO 自己已经传了 cwd，
**默认不需要启用**。保留它只为将来 AO 版本若丢失该行为时能用：

```powershell
# 只在 AO 未来版本确实不传 cwd 时才需要
$env:AO_CODEX_CWD = 'E:\YourProject\.ao-worktrees\<session>'
$env:AO_CODEX_REAL = 'C:\path\to\real\codex.exe'
node codex-cwd-proxy.js app-server
```

## 排查记录

几个踩过的坑，写在这里省得重踩。

### 1. `cordis.patch.yml` 的两种写法

DSH 的 profile patch 层：

| 写法 | 作用 |
|---|---|
| `- id: <name>` | **覆盖**已有条目。条目不存在时报 `patch: entry "<name>" not found` 并静默丢弃 |
| `- insert: [...]` | **插入**新条目 |

给 `acp` profile 加 `mcp-client` 必须用 `insert`，因为该 profile 里本来没有这个条目。

验证：`dsh --profile acp --dump-config 2>&1 | findstr "not found"`

### 2. `.env` 不能设 `DSH_` 前缀的变量

DSH 内核（`dsh-app-boot`）会拒绝 `.env` 里的引导类变量：

```
BOOTSTRAP_PREFIXES = ["DSH_", "XDG_", "DYLD_", "BASH_FUNC_"]
```

读到就 `throw`，Harness 启动即退出。所以网关密钥要用**不带 `DSH_` 前缀**的名字：

```env
# ❌ 会让 DSH 起不来
DSH_OPENAI_GATEWAY_API_KEY=xxx

# ✅
JETHUB_GATEWAY_KEY=xxx
```

唯一豁免是 home 层的 4 个代理变量（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`）。

### 3. magpie 会改写 codex 的 config.toml

直接改 `config.toml` 的 `model` 行，magpie 下次运行会改回去。

**必须通过 magpie 改**：

```powershell
# 查看
& "D:\Program Files\magpie-windows-amd64.exe" codex

# 改模型
& "D:\Program Files\magpie-windows-amd64.exe" codex auto/gpt-5.6-sol
```

### 4. 会话删不掉（`SESSION_HISTORY_SHARED`）

```
This session's turns belong to a conversation that outlives it,
so it cannot be deleted.
```

AO 没有删除 conversation 的 API，属于设计上的历史保护。
仅占 SQLite 记录，不占磁盘、不影响性能。可在 AO 界面归档。
