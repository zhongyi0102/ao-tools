#!/usr/bin/env node
/**
 * ao-config — AO 工具链的统一配置解析（方案 C：四层兜底）
 *
 * 解决的问题：
 *   以前 repo / project 写死在每个脚本里（'E:\\CloverStart'、'cloverstart'），
 *   换项目或换电脑就全废。这里收敛成一处，所有脚本都从这里取。
 *
 * 解析优先级（前面的赢）：
 *   1. 环境变量     AO_REPO / AO_PROJECT / AO_CONTEXT_DIR
 *   2. 配置文件     ~/.ao/config.json（可管多个项目，见下方 defaultProject）
 *   3. git 自动探测  git rev-parse --show-toplevel（当前仓库根）
 *   4. 当前目录     process.cwd()
 *
 * 为什么要有第 3 层：
 *   在任意仓库里直接 `node ~/.ao/tools/ao-control.js status` 就能用，
 *   不用先配环境变量。这是"丢哪都能跑"的关键。
 *
 * 配置文件格式（可选，不建也能用）：
 *   {
 *     "defaultProject": "cloverstart",
 *     "projects": {
 *       "cloverstart": { "repo": "E:\\CloverStart" },
 *       "other":       { "repo": "D:\\Other" }
 *     }
 *   }
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** AO 数据根目录（标准位置，不随项目变） */
const AO_HOME = path.join(os.homedir(), '.ao');
const CONFIG_FILE = path.join(AO_HOME, 'config.json');

// ── 基础工具 ────────────────────────────────────────────────

/** 去尾部斜杠/反斜杠，统一成反斜杠（Windows 惯例，但保留其他平台原样） */
function normalizeDir(p) {
  if (!p) return '';
  let s = String(p).trim();
  if (!s) return '';
  // 去掉包裹的引号（用户可能从资源管理器复制了带引号的路径）
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (process.platform === 'win32') {
    s = s.replace(/\//g, '\\');
    // 保留盘符根 "C:\" 的尾斜杠
    if (/^[A-Za-z]:\\$/.test(s)) return s;
    s = s.replace(/\\+$/, '');
  } else {
    s = s.replace(/\/+$/, '');
  }
  return s;
}

/** 静默执行一条命令，成功返回 stdout（trim），失败返回 null */
function tryExec(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

// ── 第 2 层：配置文件 ──────────────────────────────────────

let _configCache = null;

/**
 * 读 ~/.ao/config.json。
 * 文件不存在 / 损坏 / 无读权限 → 一律返回空对象（不抛异常），
 * 让上层继续回退到 git 探测。配置永远不该是致命依赖。
 */
function loadConfigFile() {
  if (_configCache !== null) return _configCache;
  _configCache = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') _configCache = parsed;
    }
  } catch (e) {
    // 配置坏了不能挡住工具运行，只提示一次
    process.stderr.write(`[ao-config] 警告：${CONFIG_FILE} 读取失败（${e.message}），改用自动探测\n`);
  }
  return _configCache;
}

/** 从配置文件里按项目名取 repo；取不到返回 '' */
function repoFromConfig(projectName) {
  const cfg = loadConfigFile();
  if (!cfg || !cfg.projects) return '';
  const name = projectName || cfg.defaultProject;
  if (!name) return '';
  const entry = cfg.projects[name];
  if (!entry) return '';
  return normalizeDir(typeof entry === 'string' ? entry : entry.repo);
}

/** 配置文件里声明的默认项目名 */
function defaultProjectFromConfig() {
  const cfg = loadConfigFile();
  return (cfg && typeof cfg.defaultProject === 'string') ? cfg.defaultProject : '';
}

// ── 第 3 层：git 自动探测 ──────────────────────────────────

/**
 * 从 dir 向上找 git 仓库根。
 *
 * 注意 linked worktree：在 worktree 里跑会返回 worktree 自己的根，
 * 这是期望行为（worker 就该操作自己的 worktree）。
 */
function gitRootOf(dir) {
  if (!dir) return '';
  const out = tryExec('git', ['rev-parse', '--show-toplevel'], dir);
  return out ? normalizeDir(out) : '';
}

// ── 对外主函数 ──────────────────────────────────────────────

/**
 * 解析当前生效的仓库根目录。
 *
 * @param {string} [explicit] 调用方显式传入的路径（优先级最高，供 --repo 参数用）
 * @returns {string} 绝对路径；全部失败时返回 cwd
 */
function resolveRepo(explicit) {
  // 0. 调用方显式指定
  const e = normalizeDir(explicit);
  if (e) return e;

  // 1. 环境变量
  const envRepo = normalizeDir(process.env.AO_REPO);
  if (envRepo) return envRepo;

  // 2. 配置文件（先按 AO_PROJECT 找，再按 defaultProject 找）
  const envProject = (process.env.AO_PROJECT || '').trim();
  const cfgRepo = repoFromConfig(envProject) || repoFromConfig('');
  if (cfgRepo) return cfgRepo;

  // 3. git 自动探测：从 cwd 向上找
  const gitRoot = gitRootOf(process.cwd());
  if (gitRoot) return gitRoot;

  // 4. 兜底：cwd
  return normalizeDir(process.cwd());
}

/**
 * 解析项目名（AO 的 --project 参数值）。
 *
 * 顺序：AO_PROJECT → 配置文件 defaultProject → 从仓库路径推断。
 *
 * 推断规则：AO 的 worktree 路径形如
 *   <仓库根>\.ao\data\worktrees\<项目名>\<会话名>
 * 所以路径里出现 \.ao\data\worktrees\<name>\ 时，<name> 就是项目名。
 * 这比"取目录名"可靠得多 —— worktree 目录名是 cloverstart-25，
 * 但项目名是 cloverstart。
 *
 * 兜底：仓库目录名转小写。
 */
function resolveProject(explicit) {
  const e = (explicit || '').trim();
  if (e) return e;

  const envProject = (process.env.AO_PROJECT || '').trim();
  if (envProject) return envProject;

  const cfgDefault = defaultProjectFromConfig();
  if (cfgDefault) return cfgDefault;

  // 从 worktree 路径推断：...\.ao\data\worktrees\<project>\<session>
  const repo = resolveRepo();
  const m = repo.match(/[\\/]\.ao[\\/]data[\\/]worktrees[\\/]([^\\/]+)[\\/]?/i);
  if (m && m[1]) return m[1].toLowerCase();

  // 兜底：仓库目录名
  try {
    return path.basename(repo).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 解析共享上下文目录（.ao-context）。
 * AO_CONTEXT_DIR 环境变量 > 仓库根下 .ao-context
 */
function resolveContextDir(repoDir) {
  const env = normalizeDir(process.env.AO_CONTEXT_DIR);
  if (env) return env;
  return path.join(repoDir || resolveRepo(), '.ao-context');
}

/** ao.exe 路径（标准安装位置，不随项目变） */
function resolveAoBin() {
  const env = process.env.AO_BIN;
  if (env && fs.existsSync(env)) return env;
  const guess = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs', 'agent-orchestrator', 'resources', 'daemon', 'ao.exe'
  );
  return guess;
}

/** 本文件所在目录（= ~/.ao/tools），供各脚本定位兄弟文件 */
const TOOLS_DIR = __dirname;

module.exports = {
  AO_HOME,
  CONFIG_FILE,
  TOOLS_DIR,
  normalizeDir,
  resolveRepo,
  resolveProject,
  resolveContextDir,
  resolveAoBin,
  loadConfigFile,
};
