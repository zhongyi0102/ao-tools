#!/usr/bin/env node
/**
 * codex-cwd-proxy — 在 AO 与 codex app-server 之间补 cwd
 *
 * 背景：
 *   AO 通过 `codex app-server`（长驻 JSON-RPC 服务）驱动 Codex。
 *   协议里 `thread/start` 有 `cwd` 字段（见 ThreadStartParams.json:343），
 *   但 AO 没有传，导致 Codex 用主仓库而不是 AO 分配的 worktree。
 *
 * 本代理做的事：
 *   1. 双向转发 stdin/stdout 的 JSON-RPC
 *   2. 拦截 `thread/start`，若 params.cwd 缺失则补上
 *   3. 同时把 codex 进程的 cwd 也设为同一目录（双保险）
 *
 * cwd 来源优先级：
 *   1. 环境变量 AO_CODEX_CWD        （显式指定，最高优先级）
 *   2. 命令行参数 --cwd <path>
 *   3. 本进程的 cwd（继承自 AO 的 chat-host）
 *   4. 环境变量 AO_WORKTREE_PATH
 *
 * 用法（通常由 wrapper 调用，不直接跑）：
 *   node codex-cwd-proxy.js app-server
 *   AO_CODEX_CWD=E:\proj\.ao-worktrees\x node codex-cwd-proxy.js app-server
 *
 * 日志：
 *   %TEMP%\codex-cwd-proxy.log
 *   设 AO_CODEX_PROXY_LOG=0 可关闭
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 配置 ────────────────────────────────────────────────────

/** 真实 codex 可执行文件（可用 AO_CODEX_REAL 覆盖） */
const REAL_CODEX = process.env.AO_CODEX_REAL
  || 'E:\\npm\\global\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';

const LOG_PATH = path.join(os.tmpdir(), 'codex-cwd-proxy.log');
const LOG_ENABLED = process.env.AO_CODEX_PROXY_LOG !== '0';

// ── 日志 ────────────────────────────────────────────────────
function log(msg) {
  if (!LOG_ENABLED) return;
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {}
}

// ── 解析参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
let forcedCwd = process.env.AO_CODEX_CWD || null;

const cwdIdx = argv.indexOf('--cwd');
if (cwdIdx >= 0 && argv[cwdIdx + 1]) {
  forcedCwd = argv[cwdIdx + 1];
  argv.splice(cwdIdx, 2);
}

if (!forcedCwd) {
  forcedCwd = process.env.AO_WORKTREE_PATH || process.cwd();
}

// 归一化（去掉尾部斜杠）
forcedCwd = forcedCwd.replace(/[\\/]+$/, '');

// ── 启动真实 codex ──────────────────────────────────────────
log('=== 代理启动 ===');
log(`真实 codex : ${REAL_CODEX}`);
log(`args       : ${JSON.stringify(argv)}`);
log(`注入 cwd   : ${forcedCwd}`);
log(`继承 cwd   : ${process.cwd()}`);

if (!fs.existsSync(REAL_CODEX)) {
  log(`❌ 找不到 codex: ${REAL_CODEX}`);
  process.stderr.write(`codex-cwd-proxy: 找不到 codex 可执行文件: ${REAL_CODEX}\n`);
  process.stderr.write(`  用 AO_CODEX_REAL 环境变量指定真实路径\n`);
  process.exit(1);
}

let child;
try {
  child = spawn(REAL_CODEX, argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: forcedCwd,           // 双保险 1：进程 cwd
    env: process.env,
    windowsHide: true,
  });
} catch (e) {
  log(`❌ spawn 失败: ${e.message}`);
  process.stderr.write(`codex-cwd-proxy: spawn 失败: ${e.message}\n`);
  process.exit(1);
}

log(`codex 已启动, PID ${child.pid}`);

// ── 双向转发 ────────────────────────────────────────────────

/** 父 → 子：逐行解析，拦截 thread/start 补 cwd */
let inBuf = '';
process.stdin.on('data', (chunk) => {
  inBuf += chunk.toString('utf8');
  let idx;
  while ((idx = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    if (!line.trim()) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // 不是 JSON，原样转发
      child.stdin.write(line + '\n');
      continue;
    }

    noteCapabilities(msg);
    patchCwd(msg);
    child.stdin.write(JSON.stringify(msg) + '\n');
  }
});

/** 子 → 父：原样透传 */
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));

// ── cwd 补丁逻辑 ────────────────────────────────────────────
function patchCwd(msg) {
  // 只处理 thread/start（可能还有 thread/fork、thread/resume）
  const methods = ['thread/start', 'thread/fork', 'thread/resume'];
  if (!methods.includes(msg.method)) return;

  if (!msg.params) msg.params = {};

  const existing = msg.params.cwd;
  if (existing) {
    log(`${msg.method}: 已有 cwd=${existing}，不改`);
    return;
  }

  msg.params.cwd = forcedCwd;
  log(`${msg.method}: 补 cwd=${forcedCwd}`);

  // 注意：runtimeWorkspaceRoots 需要 experimentalApi 能力，默认不传，
  // 否则 codex 直接拒绝：
  //   thread/start.runtimeWorkspaceRoots requires experimentalApi capability
  // 只有客户端显式声明了 experimentalApi 才补。
  if (msg.params.runtimeWorkspaceRoots == null && experimentalApiEnabled) {
    msg.params.runtimeWorkspaceRoots = [forcedCwd];
    log(`${msg.method}: 补 runtimeWorkspaceRoots=[${forcedCwd}]`);
  }
}

/** 客户端是否声明了 experimentalApi 能力（从 initialize 里读） */
let experimentalApiEnabled = false;

function noteCapabilities(msg) {
  if (msg.method !== 'initialize' || !msg.params) return;
  const caps = msg.params.capabilities || {};
  // 不同版本字段名不同，都探一遍
  const flag = caps.experimentalApi ?? caps.experimental_api ?? caps.experimental;
  if (flag === true) {
    experimentalApiEnabled = true;
    log('客户端声明了 experimentalApi，将补 runtimeWorkspaceRoots');
  }
}

// ── 生命周期 ────────────────────────────────────────────────
child.on('exit', (code, signal) => {
  log(`codex 退出 code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

child.on('error', (e) => {
  log(`codex 错误: ${e.message}`);
  process.stderr.write(`codex-cwd-proxy: codex 进程错误: ${e.message}\n`);
});

process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
process.stdin.on('end', () => { child.stdin.end(); });
