#!/usr/bin/env node
/**
 * sync-mcp — 把共享 MCP server 配置写进各个 agent
 *
 * 背景：AO 自己不存 MCP 配置，只从 agent 侧发现。
 * 所以「一个大脑多只手共享上下文」的正确做法是：
 *   把同一个 MCP server 写进每个 agent 的配置文件。
 *
 * 用法：
 *   node tools/sync-mcp.js            # 同步所有已知 agent
 *   node tools/sync-mcp.js --dry-run  # 只看会改什么
 *   node tools/sync-mcp.js --agent dsh,codex
 *
 * 未来加新 agent：在 AGENTS 数组里加一条即可。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const aoCfg = require('./ao-config');

// ── 共享 MCP server 定义（唯一真相源） ──────────────────────
//
// 路径在**运行时**计算：server.js 永远在 ao-config.js 的兄弟目录，
// .ao-context 永远在目标仓库根下。
//
// 写进 agent 配置的仍然是绝对路径 —— agent 启动 MCP 时不保证 cwd，
// 相对路径会失效。但「算出来的是绝对的」和「写死是绝对的」是两回事：
// 前者换项目/换电脑自动跟着变，后者一挪就废。
const SERVER_NAME = 'ao-context';
const SERVER_CMD = 'node';
const SERVER_ARGS = [path.join(aoCfg.TOOLS_DIR, 'context-mcp', 'server.js')];
const SERVER_ENV = { AO_CONTEXT_DIR: aoCfg.resolveContextDir() };

// ── agent 配置适配器 ────────────────────────────────────────
const AGENTS = [
  {
    id: 'dsh',
    label: 'DeepSeek Harness (acp profile)',
    configPath: path.join(os.homedir(), '.dsh', 'profiles', 'acp', 'cordis.patch.yml'),
    format: 'yaml-patch',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    configPath: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
    format: 'toml',
  },
  // 未来加新 agent，在这里加一条：
  // { id: 'claude', label: 'Claude Code', configPath: ..., format: 'json' },
];

// ── 各格式的写入实现 ────────────────────────────────────────

function yamlPatchBlock() {
  return `
# ── 共享上下文 MCP（由 tools/sync-mcp.js 生成，勿手改） ──
- id: mcp-client
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    transport: stdio
    serverName: ${SERVER_NAME}
    command: ${SERVER_CMD}
    args:
${SERVER_ARGS.map(a => `      - ${JSON.stringify(a)}`).join('\n')}
    env:
${Object.entries(SERVER_ENV).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n')}
    failOnStartupError: false
`;
}

/**
 * 判断配置文件里是否已经写入了正确的路径。
 *
 * 坑：写进 YAML/TOML 的是 JSON.stringify 后的字符串，
 * 路径里的 \ 会变成 \\。直接拿原始路径去 includes 永远匹配不上，
 * 会导致「每次都判定为变更、每次都重写」。
 * 所以两种形式都要比：原始形式 + JSON 转义形式。
 */
function hasPath(content, p) {
  if (!p) return false;
  if (content.includes(p)) return true;
  // JSON.stringify 会把 \ 转成 \\，去掉外层引号再比
  const escaped = JSON.stringify(p).slice(1, -1);
  return content.includes(escaped);
}

/** 已有配置且路径正确 → 无需改动 */
function configIsCurrent(content) {
  return hasPath(content, SERVER_ARGS[0]) && hasPath(content, SERVER_ENV.AO_CONTEXT_DIR);
}

function writeDshYaml(filePath, dryRun) {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(`# ── 共享上下文 MCP`)) {
      // 已有配置：检查路径是否仍然正确。
      // 工具搬家（如从 <repo>\tools 移到 ~\.ao\tools）后旧路径会失效，
      // 这时不能简单跳过，否则 MCP 会指向一个不存在的 server.js。
      if (configIsCurrent(content)) {
        return { status: 'skip', reason: '已有 ao-context 配置且路径正确' };
      }
      // 路径变了 → 删掉旧块，重新插入
      const marker = `# ── 共享上下文 MCP`;
      const idx = content.indexOf(marker);
      // 旧块从 marker 前的空行开始，到文件末尾（当初就是追加在末尾的）
      let head = content.slice(0, idx).replace(/\s+$/, '');
      const next = head + '\n' + yamlPatchBlock();
      if (!dryRun) {
        fs.writeFileSync(filePath + '.bak-syncmcp', content, 'utf8');
        fs.writeFileSync(filePath, next, 'utf8');
      }
      return { status: 'updated', reason: '路径已变更，已重写' };
    }
  } else {
    return { status: 'error', reason: `文件不存在: ${filePath}` };
  }

  // 关键：必须用 insert 形式。
  // `- id: mcp-client` 只能覆盖已存在的条目，acp profile 里没有它，
  // DSH 会报 `patch: entry "mcp-client" not found` 并静默丢弃。
  const block = yamlPatchBlock();
  const next = content.trimEnd() + '\n' + block;

  if (!dryRun) {
    fs.writeFileSync(filePath + '.bak-syncmcp', content, 'utf8');
    fs.writeFileSync(filePath, next, 'utf8');
  }
  return { status: 'written', bytes: block.length };
}

function tomlBlock() {
  const envLines = Object.entries(SERVER_ENV)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join('\n');
  const argsLines = SERVER_ARGS.map(a => JSON.stringify(a)).join(', ');
  return `
# ── 共享上下文 MCP（由 tools/sync-mcp.js 生成，勿手改） ──
[mcp_servers.${SERVER_NAME}]
command = ${JSON.stringify(SERVER_CMD)}
args = [${argsLines}]

[mcp_servers.${SERVER_NAME}.env]
${envLines}
`;
}

function writeCodexToml(filePath, dryRun) {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(`[mcp_servers.${SERVER_NAME}]`)) {
      // 同 DSH：路径正确才跳过，否则整段替换
      if (configIsCurrent(content)) {
        return { status: 'skip', reason: '已有 ao-context 配置且路径正确' };
      }
      // 删掉旧的 [mcp_servers.ao-context] 段（含其 env 子段），到下一个 [ 开头的段或文件末尾
      const startMarker = `[mcp_servers.${SERVER_NAME}]`;
      const start = content.indexOf(startMarker);
      let tail = content.slice(start + startMarker.length);
      // 找下一个顶级段
      const nextSection = tail.search(/\n\[(?!mcp_servers\.)/);
      const after = nextSection >= 0 ? tail.slice(nextSection) : '';
      const head = content.slice(0, start).replace(/\s+$/, '');
      const next = head + (head ? '\n\n' : '') + tomlBlock().trim() + (after ? '\n' + after.replace(/^\n+/, '\n') : '') + '\n';
      if (!dryRun) {
        fs.writeFileSync(filePath + '.bak-syncmcp', content, 'utf8');
        fs.writeFileSync(filePath, next, 'utf8');
      }
      return { status: 'updated', reason: '路径已变更，已重写' };
    }
  } else {
    // 文件不存在则创建
    content = '';
  }

  const block = tomlBlock();
  const next = content.trimEnd() + (content ? '\n' : '') + block;

  if (!dryRun) {
    if (content) fs.writeFileSync(filePath + '.bak-syncmcp', content, 'utf8');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next, 'utf8');
  }
  return { status: 'written', bytes: block.length };
}

// ── 主流程 ──────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const agentFilter = (() => {
    const i = args.indexOf('--agent');
    return i >= 0 && args[i + 1] ? args[i + 1].split(',').map(s => s.trim()) : null;
  })();

  console.log('=== sync-mcp: 把 ao-context 写进各 agent ===');
  console.log(`模式: ${dryRun ? '预览' : '实际写入'}`);
  console.log(`MCP:  ${SERVER_NAME} → ${SERVER_CMD} ${SERVER_ARGS.join(' ')}`);
  console.log(`数据: ${SERVER_ENV.AO_CONTEXT_DIR}`);
  console.log('');

  const targets = agentFilter
    ? AGENTS.filter(a => agentFilter.includes(a.id))
    : AGENTS;

  if (targets.length === 0) {
    console.log('没有匹配的 agent。已知:', AGENTS.map(a => a.id).join(', '));
    process.exit(1);
  }

  let changed = 0, skipped = 0, failed = 0;

  for (const agent of targets) {
    console.log(`[${agent.id}] ${agent.label}`);
    console.log(`  配置: ${agent.configPath}`);

    let result;
    try {
      if (agent.format === 'yaml-patch') {
        result = writeDshYaml(agent.configPath, dryRun);
      } else if (agent.format === 'toml') {
        result = writeCodexToml(agent.configPath, dryRun);
      } else {
        result = { status: 'error', reason: `未知格式: ${agent.format}` };
      }
    } catch (err) {
      result = { status: 'error', reason: err.message };
    }

    if (result.status === 'written') {
      console.log(`  ✅ ${dryRun ? '将写入' : '已写入'} ${result.bytes} 字节`);
      changed++;
    } else if (result.status === 'updated') {
      console.log(`  ♻️  ${dryRun ? '将重写' : '已重写'}：${result.reason}`);
      changed++;
    } else if (result.status === 'skip') {
      console.log(`  ⏭  跳过：${result.reason}`);
      skipped++;
    } else {
      console.log(`  ❌ 失败：${result.reason}`);
      failed++;
    }
    console.log('');
  }

  console.log(`=== 完成：写入 ${changed} / 跳过 ${skipped} / 失败 ${failed} ===`);
  if (dryRun && changed > 0) {
    console.log('（预览模式，未实际修改。去掉 --dry-run 执行）');
  }
  if (changed > 0 && !dryRun) {
    console.log('');
    console.log('⚠️  需要重启对应的 agent 才生效：');
    console.log('   - DSH: 重启 DSH 桌面端');
    console.log('   - Codex: 下次启动自动生效');
  }
}

main();
