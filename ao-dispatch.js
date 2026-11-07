#!/usr/bin/env node
/**
 * ao-dispatch — AO 任务智能分配（B + D 混合）
 *
 * B 层（关键词粗筛，零依赖、毫秒级）
 *   从 ao-dispatch.rules.json 读规则，命中即定 agent。
 *
 * D 层（语义兜底，可选）
 *   关键词没命中 / 置信度低时，调本地 Semantic Router 服务做语义分类。
 *   服务没启动就降级到 default 规则，不阻塞派活。
 *
 * 用法：
 *   node tools/ao-dispatch.js plan "任务描述"          看决策
 *   node tools/ao-dispatch.js plan --json "..."        决策输出 JSON
 *   node tools/ao-dispatch.js run "任务描述"           决策 + 派活
 *   node tools/ao-dispatch.js run --dry-run "..."      只看会跑什么命令
 *   node tools/ao-dispatch.js rules                    打印规则表
 *   node tools/ao-dispatch.js rules --json             规则原文
 *   node tools/ao-dispatch.js audit [--days N] [--json] 审计统计
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const aoCfg = require('./ao-config');

// ── 配置 ────────────────────────────────────────────────────
//
// repo / project 不再写死：由 ao-config 按
// 「环境变量 → ~/.ao/config.json → git 探测 → cwd」解析。
// 换项目时设 AO_PROJECT，换电脑时什么都不用配。
const CFG = {
  repo: aoCfg.resolveRepo(),
  project: aoCfg.resolveProject(),
  aoBin: aoCfg.resolveAoBin(),
  rulesPath: path.join(__dirname, 'ao-dispatch.rules.json'),
  auditDir: path.join(os.homedir(), '.ao', 'logs', 'dispatch'),
};

// ── WAL 审计日志 ────────────────────────────────────────────
//
// 每次路由决策落一行 JSON（按天分文件），用于事后统计与规则调优。
// 只记 prompt 的 sha256 前 16 位与长度，不存原文 —— 避免日志膨胀与隐私问题。
//
// 铁律：日志失败绝不影响主流程。全部 try/catch 吞掉，只 warn 一次。
let auditWarned = false;

function auditPath(date = new Date()) {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return path.join(CFG.auditDir, `decisions-${day}.jsonl`);
}

/** 提示词指纹：sha256 前 16 位。 */
function promptHash(prompt) {
  return crypto.createHash('sha256').update(String(prompt), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 追加一条决策记录。永不抛异常。
 * @param {object} rec 至少含 prompt / layer / ruleId / harness / model / needsWrite / ok / reason
 */
function auditLog(rec) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      promptHash: promptHash(rec.prompt ?? ''),
      promptLen: String(rec.prompt ?? '').length,
      layer: rec.layer ?? null,
      ruleId: rec.ruleId ?? null,
      harness: rec.harness ?? null,
      model: rec.model ?? null,
      needsWrite: rec.needsWrite ?? null,
      ok: rec.ok === undefined ? null : rec.ok,
      reason: rec.reason ?? null,
    });
    fs.mkdirSync(CFG.auditDir, { recursive: true });
    fs.appendFileSync(auditPath(), line + '\n', 'utf8');
  } catch (e) {
    if (!auditWarned) {
      auditWarned = true;
      try {
        console.warn(`⚠️  审计日志写入失败（不影响派活）：${e.message}`);
      } catch { /* 连 warn 都失败就彻底放弃 */ }
    }
  }
}

// ── 规则加载 ────────────────────────────────────────────────
let RULES = null;

function loadRules() {
  if (RULES) return RULES;
  try {
    const raw = fs.readFileSync(CFG.rulesPath, 'utf8');
    RULES = JSON.parse(raw);
    // 按 priority 排序（小优先）
    RULES.rules.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    return RULES;
  } catch (e) {
    console.error(`❌ 规则文件读取失败: ${CFG.rulesPath}`);
    console.error(`   ${e.message}`);
    console.error('   用默认规则继续（全部 → deepseek-harness）');
    RULES = {
      agents: {
        'deepseek-harness': {
          enabled: true, label: 'DeepSeek Harness', respectsWorktree: true,
          costTier: 1, models: { normal: '["jethub","buddy/deepseek-v4-flash"]' },
          notes: '默认',
        },
      },
      limits: { maxActiveSessions: 3, maxPerAgent: 2 },
      rules: [],
      default: { id: 'default', label: '默认', target: 'deepseek-harness', needsWrite: true, model: 'normal', reason: '规则文件缺失' },
      semantic: { enabled: false },
    };
    return RULES;
  }
}

// ── 工具 ────────────────────────────────────────────────────
function sh(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        encoding: 'utf8',
        cwd: opts.cwd || CFG.repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeout || 60000,
      }).trim(),
    };
  } catch (e) {
    return { ok: false, err: ((e.stderr || '') + (e.stdout || '') || e.message || '').toString().trim() };
  }
}

function ao(args) { return sh(CFG.aoBin, args); }

// ── AO 状态查询 ─────────────────────────────────────────────
function getReadiness() {
  const r = ao(['agent', 'ls']);
  if (!r.ok) return {};
  const map = {};
  for (const line of r.out.split('\n')) {
    const m = line.match(/^(\S+)\s{2,}(\S.*?)\s{2,}(installed|needs install)\s{2,}(.+)$/);
    if (m) map[m[1]] = { id: m[1], label: m[2].trim(), installed: m[3] === 'installed', auth: m[4].trim() };
  }
  return map;
}

function getActiveSessions() {
  const r = ao(['session', 'ls', '--all', '--json']);
  if (!r.ok) return [];
  try {
    const d = JSON.parse(r.out);
    const list = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : []);
    return list.filter(s => !(s.isTerminated === true || s.status === 'terminated' || s.activity === 'exited'));
  } catch { return []; }
}

// ── B 层：关键词匹配 ────────────────────────────────────────
function matchByKeyword(prompt) {
  const R = loadRules();
  const lower = prompt.toLowerCase();

  for (const rule of R.rules) {
    // 关键词
    for (const kw of (rule.keywords || [])) {
      if (lower.includes(kw.toLowerCase())) {
        return { rule, matchedBy: `关键词「${kw}」`, layer: 'B-keyword' };
      }
    }
    // 扩展名
    for (const ext of (rule.extensions || [])) {
      if (lower.includes(ext.toLowerCase())) {
        return { rule, matchedBy: `扩展名「${ext}」`, layer: 'B-ext' };
      }
    }
    // 路径模式
    for (const p of (rule.pathPatterns || [])) {
      if (lower.includes(p.toLowerCase())) {
        return { rule, matchedBy: `路径「${p}」`, layer: 'B-path' };
      }
    }
  }

  return null;
}

// ── D 层：语义兜底 ──────────────────────────────────────────
// ── D 层：语义兜底（支持按需自启）───────────────────────────

/**
 * 检查语义服务是否在线。
 * @returns {Promise<boolean>}
 */
async function isSemanticAlive(endpoint, timeoutMs = 800) {
  // endpoint 形如 http://127.0.0.1:8765/route → 探 /health
  const healthUrl = endpoint.replace(/\/route\s*$/, '/health');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 按需启动语义服务（后台，不阻塞）。
 * 用 uv run 启动，日志落到 %TEMP%。
 * @returns {boolean} 是否成功拉起进程
 */
function spawnSemanticServer() {
  const { spawn } = require('child_process');
  const serverDir = path.join(__dirname, 'semantic-router');
  const serverPy = path.join(serverDir, 'server.py');

  if (!fs.existsSync(serverPy)) {
    return { ok: false, reason: `找不到 ${serverPy}` };
  }

  const logPath = path.join(os.tmpdir(), 'ao-semantic-router.log');
  const logFd = (() => {
    try { return fs.openSync(logPath, 'a'); } catch { return 'ignore'; }
  })();

  try {
    const child = spawn('uv', ['run', 'server.py'], {
      cwd: serverDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      shell: true,          // Windows 下 uv 是 .cmd，需要 shell
      windowsHide: true,
    });
    child.unref();
    return { ok: true, pid: child.pid, log: logPath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 等语义服务就绪（轮询 /health）。
 * @returns {Promise<boolean>}
 */
async function waitSemanticReady(endpoint, maxWaitMs = 60000) {
  const deadline = Date.now() + maxWaitMs;
  let delay = 500;
  while (Date.now() < deadline) {
    if (await isSemanticAlive(endpoint, 800)) return true;
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
  }
  return false;
}

async function matchBySemantic(prompt) {
  const R = loadRules();
  const sem = R.semantic || {};
  if (!sem.enabled) return { skipped: '未启用' };

  const endpoint = sem.endpoint;

  // ── 按需自启 ──
  let autostartNote = '';
  if (!(await isSemanticAlive(endpoint))) {
    const started = spawnSemanticServer();
    if (!started.ok) {
      return { error: `服务未运行且启动失败：${started.reason}` };
    }
    autostartNote = `已拉起服务(PID ${started.pid})，等待就绪…`;
    const ready = await waitSemanticReady(endpoint, sem.autostartTimeoutMs || 60000);
    if (!ready) {
      return { error: `服务启动超时（日志：${started.log}）`, autostartNote };
    }
    autostartNote += ' 就绪';
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sem.timeoutMs || 2000);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt, routes: R.rules.map(r => r.id) }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) return { error: `HTTP ${resp.status}`, autostartNote };
    const data = await resp.json();

    if (!data.route || typeof data.confidence !== 'number') {
      return { error: '响应格式不对（需要 {route, confidence}）', autostartNote };
    }
    if (data.confidence < (sem.threshold || 0.6)) {
      return { lowConfidence: true, route: data.route, confidence: data.confidence, autostartNote };
    }

    const rule = R.rules.find(r => r.id === data.route);
    if (!rule) return { error: `未知 route: ${data.route}`, autostartNote };

    return {
      rule,
      matchedBy: `语义「${data.route}」conf=${data.confidence.toFixed(2)}`,
      layer: 'D-semantic',
      confidence: data.confidence,
      autostartNote,
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? '超时' : e.message, autostartNote };
  }
}

// ── 决策 ────────────────────────────────────────────────────
//
// decide() 内部只做决策；decideWithAudit() 在外面补一条 WAL 记录。
// 分开写是因为 decide() 有多条提前返回路径（约束不满足、agent 禁用…），
// 包装一层才能保证每条路径都被记到，且新增返回分支时不会漏审计。
async function decide(prompt) {
  const R = loadRules();
  const trace = [];
  const readiness = getReadiness();
  const active = getActiveSessions();
  const activeByHarness = {};
  for (const s of active) activeByHarness[s.harness] = (activeByHarness[s.harness] || 0) + 1;

  trace.push(`输入：${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`);
  trace.push('');

  // B 层
  trace.push('【B 层 · 关键词】');
  const kw = matchByKeyword(prompt);
  let rule, matchedBy, layer;

  if (kw) {
    rule = kw.rule;
    matchedBy = kw.matchedBy;
    layer = kw.layer;
    trace.push(`  ✓ 命中 ${rule.label}（${matchedBy}）`);
  } else {
    trace.push('  ✗ 未命中任何关键词规则');

    // D 层兜底
    trace.push('');
    trace.push('【D 层 · 语义兜底】');
    const sem = await matchBySemantic(prompt);

    if (sem.autostartNote) {
      trace.push(`  ⚙️  ${sem.autostartNote}`);
    }

    if (sem.rule) {
      rule = sem.rule;
      matchedBy = sem.matchedBy;
      layer = sem.layer;
      trace.push(`  ✓ ${sem.matchedBy}`);
    } else if (sem.skipped) {
      trace.push(`  ⏭  跳过（${sem.skipped}）`);
      rule = R.default;
      matchedBy = '(default)';
      layer = 'fallback';
    } else if (sem.lowConfidence) {
      trace.push(`  ⚠️  置信度不足（${sem.route} conf=${sem.confidence.toFixed(2)} < ${R.semantic.threshold}）`);
      rule = R.default;
      matchedBy = '(default，置信度不足)';
      layer = 'fallback';
    } else {
      trace.push(`  ⚠️  不可用（${sem.error}）`);
      rule = R.default;
      matchedBy = '(default，语义服务不可用)';
      layer = 'fallback';
    }
  }

  trace.push('');
  trace.push(`规则：${rule.label}（id=${rule.id}）`);
  trace.push(`目标：${rule.target}`);
  trace.push(`是否写文件：${rule.needsWrite ? '是' : '否'}`);

  // ── 约束检查 ──
  //
  // 这些分支都是「决策已完成、但派不出去」。必须带上 layer / matchedBy，
  // 否则审计日志会把命中了 B 层的任务记成 blocked，统计就失真了。
  const fail = (error) => ({ ok: false, trace, rule, layer, matchedBy, error });

  const agent = R.agents[rule.target];
  if (!agent) {
    return fail(`规则 ${rule.id} 指向的 agent ${rule.target} 不在配置里`);
  }
  if (agent.enabled === false) {
    return fail(`${agent.label} 已禁用（agents.${rule.target}.enabled=false）`);
  }

  const ready = readiness[rule.target];
  if (!ready) return fail(`${agent.label}：AO 未识别`);
  if (!ready.installed) return fail(`${agent.label}：未安装`);
  if (/needs auth/i.test(ready.auth)) return fail(`${agent.label}：需要授权`);

  // Codex 不尊重 worktree → 只允许只读
  if (!agent.respectsWorktree && rule.needsWrite) {
    return fail(
      `${agent.label} 不尊重 worktree，但规则 ${rule.id} 要求写文件。\n` +
        `  处理：\n` +
        `    1. 把任务改成只读措辞（"只分析不改"）\n` +
        `    2. 或手动 --harness deepseek-harness\n` +
        `    3. 或改规则文件把 ${rule.id} 的 target 换成 deepseek-harness`,
    );
  }

  const load = activeByHarness[rule.target] || 0;
  const maxPerAgent = R.limits?.maxPerAgent ?? 2;
  if (load >= maxPerAgent) {
    return fail(`${agent.label} 已有 ${load} 个活跃会话（上限 ${maxPerAgent}）`);
  }

  const maxActive = R.limits?.maxActiveSessions ?? 3;
  if (active.length >= maxActive) {
    return fail(`活跃会话 ${active.length} 个已达上限 ${maxActive}，先清理再派活`);
  }

  const model = agent.models?.[rule.model] || agent.models?.normal || null;

  trace.push('');
  trace.push(`就绪：${agent.label}（load=${load}/${maxPerAgent}）`);
  trace.push(`模型：${model || '(默认)'}`);

  return {
    ok: true,
    trace,
    rule,
    layer,
    matchedBy,
    agent,
    harness: rule.target,
    model,
    needsWrite: rule.needsWrite,
    activeCount: active.length,
    maxActive,
  };
}

/**
 * decide() + 一条 WAL 审计记录。
 * ok 在这里固定为 null：plan 只是「会派给谁」，真正的成功与否由 run 路径记录。
 * @param {string} prompt
 * @param {object} [auditExtra] 额外覆盖的审计字段（run 路径用它写 ok/model）
 */
async function decideWithAudit(prompt, auditExtra = {}) {
  const plan = await decide(prompt);

  auditLog({
    prompt,
    layer: plan.layer ?? 'unknown',
    ruleId: plan.rule?.id ?? null,
    harness: plan.rule?.target ?? null,
    model: plan.model ?? null,
    needsWrite: plan.rule?.needsWrite ?? null,
    ok: null,                       // plan 模式：未真正派活
    reason: plan.rule?.reason ?? plan.error ?? null,
    ...auditExtra,
  });

  return plan;
}

// ── 输出 ────────────────────────────────────────────────────
function printPlan(plan) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  AO 任务分配决策');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  plan.trace.forEach(l => console.log(l ? '  ' + l : ''));

  if (!plan.ok) {
    console.log('');
    console.log(`  ❌ ${plan.error}`);
    return;
  }

  console.log('');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  harness   : ${plan.harness}`);
  console.log(`  model     : ${plan.model || '(默认)'}`);
  console.log(`  决策层    : ${plan.layer}`);
  console.log(`  活跃会话  : ${plan.activeCount}/${plan.maxActive}`);
  console.log('');
}

// ── 模型饱和检测与降级 ──────────────────────────────────────

/** 上游饱和的错误特征（腾讯积分 14003 model busy） */
const SATURATION_PATTERNS = [
  /model busy/i,
  /模型繁忙/,
  /请求量饱和/,
  /14003/,
  /已重试\s*\d+\s*次仍未通过/,
];

function isSaturated(text) {
  if (!text) return false;
  return SATURATION_PATTERNS.some(re => re.test(text));
}

/**
 * 按优先级排列候选模型：当前模型 → 降级链。
 * 降级链从 agents.<id>.models 里取，按 cheap/normal/strong 顺序，
 * 跳过与当前模型相同的。
 */
function modelFallbackChain(agentId, currentModel) {
  const R = loadRules();
  const agent = R.agents[agentId];
  if (!agent || !agent.models) return [];

  const order = ['cheap', 'normal', 'strong'];
  const seen = new Set([currentModel]);
  const chain = [];

  for (const tier of order) {
    const m = agent.models[tier];
    if (m && !seen.has(m)) {
      seen.add(m);
      chain.push({ tier, model: m });
    }
  }
  // 兜底：配置里所有其它模型
  for (const [tier, m] of Object.entries(agent.models)) {
    if (m && !seen.has(m)) {
      seen.add(m);
      chain.push({ tier, model: m });
    }
  }
  return chain;
}

/**
 * 派活并在饱和时自动降级模型重试。
 * @returns {{ok: boolean, out?: string, err?: string, usedModel?: string, attempts: Array}}
 */
async function spawnWithFallback(prompt, plan, opts) {
  const attempts = [];
  const name = opts.name || autoName(plan.rule);

  // 构造候选列表：[首选模型, ...降级链]
  const candidates = [];
  if (plan.model) candidates.push({ tier: plan.rule.model || 'normal', model: plan.model });
  for (const c of modelFallbackChain(plan.harness, plan.model)) candidates.push(c);
  if (candidates.length === 0) candidates.push({ tier: 'default', model: null });

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const args = ['spawn', '--project', CFG.project, '--harness', plan.harness,
      '--name', `${name}${i > 0 ? `-r${i}` : ''}`, '--prompt', prompt];
    if (cand.model) args.push('--model', cand.model);

    const label = cand.model || '(默认)';
    console.log(`  尝试 ${i + 1}/${candidates.length}：${label}`);

    const r = ao(args);
    attempts.push({ model: label, ok: r.ok, err: r.ok ? null : r.err.slice(0, 200) });

    if (r.ok) {
      console.log(`  ✅ 成功（${label}）`);
      return { ok: true, out: r.out, usedModel: label, attempts };
    }

    const saturated = isSaturated(r.err);
    if (saturated) {
      console.log(`     ⚠️  上游饱和，降级到下一个模型…`);
      continue;
    }

    // 非饱和错误：直接失败，不再重试
    console.log(`  ❌ 失败（${label}）：${r.err.slice(0, 300)}`);
    return { ok: false, err: r.err, usedModel: label, attempts };
  }

  // 全部饱和
  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    err: `所有模型都饱和（试了 ${attempts.length} 个）：\n` +
      attempts.map(a => `  · ${a.model}`).join('\n') +
      `\n\n  这不是账号问题，是上游模型繁忙。稍等几分钟再试，\n` +
      `  或手动指定其它模型：--model '["jethub","<模型id>"]'`,
    usedModel: last?.model,
    attempts,
  };
}

// ── 派活 ────────────────────────────────────────────────────
async function run(prompt, opts) {
  const plan = await decide(prompt);

  // run 路径要记录真实结果：成功与否、实际用的模型。
  // 先在这里落一条「决策 + 结果」，dry-run 与失败都各写各的 ok。
  const auditBase = {
    prompt,
    layer: plan.layer ?? 'unknown',
    ruleId: plan.rule?.id ?? null,
    harness: plan.rule?.target ?? null,
    needsWrite: plan.rule?.needsWrite ?? null,
    reason: plan.rule?.reason ?? plan.error ?? null,
  };
  const audit = (extra) => auditLog({ ...auditBase, model: plan.model ?? null, ...extra });

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    audit({ ok: plan.ok ? null : false });
    return plan.ok ? 0 : 1;
  }

  printPlan(plan);
  if (!plan.ok) {
    audit({ ok: false });
    return 1;
  }

  if (opts.dryRun) {
    const name = opts.name || autoName(plan.rule);
    const args = ['spawn', '--project', CFG.project, '--harness', plan.harness,
      '--name', name, '--prompt', prompt];
    if (plan.model) args.push('--model', plan.model);
    console.log('  （--dry-run，未派活）');
    console.log('  实际会跑：');
    console.log(`    ao ${args.map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' ')}`);
    const chain = modelFallbackChain(plan.harness, plan.model);
    if (chain.length) {
      console.log('  饱和降级链：');
      chain.forEach((c, i) => console.log(`    ${i + 2}. ${c.model} (${c.tier})`));
    }
    audit({ ok: null });            // dry-run：未真正派活
    return 0;
  }

  console.log('  派活中…');
  const r = await spawnWithFallback(prompt, plan, opts);
  if (!r.ok) {
    console.log('');
    console.log(`  ❌ ${r.err}`);
    audit({ ok: false, model: r.usedModel ?? plan.model ?? null });
    return 1;
  }
  console.log(`  ${r.out}`);
  audit({ ok: true, model: r.usedModel ?? plan.model ?? null });
  return 0;
}

function autoName(rule) {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  return `${rule.id}-${stamp}`;
}

// ── 规则表 ──────────────────────────────────────────────────
function printRules(asJson) {
  const R = loadRules();
  if (asJson) { console.log(JSON.stringify(R, null, 2)); return; }

  console.log('═══════════════════════════════════════════════════');
  console.log('  AO 任务分配规则');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  规则文件：${CFG.rulesPath}`);
  console.log('');

  console.log('【规则（按 priority 排序，小优先）】');
  for (const r of R.rules) {
    console.log(`  ${String(r.priority).padStart(3)}  ${r.id.padEnd(12)} → ${r.target.padEnd(18)} needsWrite=${r.needsWrite ? 'Y' : 'N'}  model=${r.model || '-'}`);
    console.log(`       ${r.reason}`);
    const sig = [...(r.keywords || []), ...(r.extensions || []), ...(r.pathPatterns || [])];
    console.log(`       ${sig.slice(0, 10).join(' / ')}${sig.length > 10 ? ` …(+${sig.length - 10})` : ''}`);
  }
  console.log(`  ---  ${R.default.id.padEnd(12)} → ${R.default.target.padEnd(18)} needsWrite=${R.default.needsWrite ? 'Y' : 'N'}`);
  console.log(`       ${R.default.reason}`);
  console.log('');

  console.log('【Agent】');
  for (const [id, a] of Object.entries(R.agents)) {
    const st = a.enabled === false ? '⛔ 禁用' : '✅ 启用';
    const wt = a.respectsWorktree ? '✅' : '❌';
    console.log(`  ${st}  ${a.label.padEnd(20)} worktree=${wt}  cost=${a.costTier}`);
    if (a.enabled !== false) console.log(`        ${a.notes}`);
  }
  console.log('');

  console.log('【限制】');
  console.log(`  活跃会话上限: ${R.limits.maxActiveSessions}`);
  console.log(`  单 agent 上限: ${R.limits.maxPerAgent}`);
  console.log('');

  const sem = R.semantic || {};
  console.log('【D 层语义兜底】');
  console.log(`  状态: ${sem.enabled ? '✅ 启用' : '⛔ 未启用'}`);
  if (sem.enabled) {
    console.log(`  端点: ${sem.endpoint}`);
    console.log(`  阈值: ${sem.threshold}`);
  } else {
    console.log('  启用方式: 改 ao-dispatch.rules.json 的 semantic.enabled = true');
    console.log('  并启动: python tools/semantic-router/server.py');
  }
  console.log('');
}

// ── 审计统计 ────────────────────────────────────────────────

/** 最近 N 天的日期串（YYYY-MM-DD），含今天。 */
function recentDays(days) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

/**
 * 读取最近 N 天的审计记录。
 * 坏行（半截写入 / 手工改坏）跳过并计数，不中断统计。
 * @returns {{records: Array, files: string[], badLines: number}}
 */
function readAudit(days) {
  const records = [];
  const files = [];
  let badLines = 0;

  for (const day of recentDays(days)) {
    const p = path.join(CFG.auditDir, `decisions-${day}.jsonl`);
    if (!fs.existsSync(p)) continue;
    files.push(p);
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { badLines++; }
    }
  }
  return { records, files, badLines };
}

/** 按 key 计数，返回 [key, count] 降序数组。 */
function countBy(records, pick) {
  const m = new Map();
  for (const r of records) {
    const k = pick(r);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function pct(n, total) {
  return total ? `${((n / total) * 100).toFixed(1)}%` : '0.0%';
}

/** 打印审计统计。 */
function printAudit(days, asJson) {
  const { records, files, badLines } = readAudit(days);
  const total = records.length;

  // ok 三态：true 成功、false 失败、null 未派活（plan / dry-run）
  const okCount = records.filter(r => r.ok === true).length;
  const failCount = records.filter(r => r.ok === false).length;
  const nullCount = records.filter(r => r.ok === null || r.ok === undefined).length;
  const dispatched = okCount + failCount;

  const byRule = countBy(records, r => r.ruleId ?? '(none)');
  const byHarness = countBy(records, r => r.harness ?? '(none)');
  const byLayer = countBy(records, r => r.layer ?? '(none)');
  const byDay = countBy(records, r => (r.ts || '').slice(0, 10) || '(none)');

  if (asJson) {
    console.log(JSON.stringify({
      days,
      files,
      total,
      badLines,
      ok: okCount,
      failed: failCount,
      notDispatched: nullCount,
      failureRate: dispatched ? Number((failCount / dispatched).toFixed(4)) : null,
      byRule: Object.fromEntries(byRule),
      byHarness: Object.fromEntries(byHarness),
      byLayer: Object.fromEntries(byLayer),
      byDay: Object.fromEntries(byDay),
    }, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════');
  console.log(`  AO 派活审计（最近 ${days} 天）`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`  日志目录：${CFG.auditDir}`);
  console.log(`  命中文件：${files.length} 个${files.length ? '' : '（还没有任何记录）'}`);
  console.log(`  总记录数：${total}${badLines ? `（跳过坏行 ${badLines}）` : ''}`);
  console.log('');

  if (!total) {
    console.log('  暂无数据。先跑几次 plan/run 再看。');
    console.log('');
    return;
  }

  console.log('【按规则】');
  for (const [k, n] of byRule) {
    console.log(`  ${String(n).padStart(5)}  ${pct(n, total).padStart(6)}  ${k}`);
  }
  console.log('');

  console.log('【按 harness】');
  for (const [k, n] of byHarness) {
    console.log(`  ${String(n).padStart(5)}  ${pct(n, total).padStart(6)}  ${k}`);
  }
  console.log('');

  console.log('【按决策层】');
  for (const [k, n] of byLayer) {
    console.log(`  ${String(n).padStart(5)}  ${pct(n, total).padStart(6)}  ${k}`);
  }
  console.log('');

  console.log('【失败率】');
  console.log(`  成功 ${okCount}  失败 ${failCount}  未派活 ${nullCount}（plan / dry-run）`);
  console.log(`  失败率：${dispatched ? pct(failCount, dispatched) : '—（没有真正派过活）'}`);
  console.log('');

  console.log('【按天汇总】');
  for (const [k, n] of byDay) {
    const dayRecs = records.filter(r => (r.ts || '').slice(0, 10) === k);
    const dOk = dayRecs.filter(r => r.ok === true).length;
    const dFail = dayRecs.filter(r => r.ok === false).length;
    console.log(`  ${k}  ${String(n).padStart(5)} 条  （成功 ${dOk} / 失败 ${dFail}）`);
  }
  console.log('');
}

// ── 入口 ────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    name: (() => { const i = argv.indexOf('--name'); return i >= 0 ? argv[i + 1] : null; })(),
  };

  const flagValues = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name' || argv[i] === '--days') flagValues.add(i + 1);
  }
  const prompt = argv.slice(1)
    .filter((a, i) => !a.startsWith('--') && !flagValues.has(i + 1))
    .join(' ')
    .trim();

  // audit 的天数：--days N，缺省 1 天；非法值回落 1
  const days = (() => {
    const i = argv.indexOf('--days');
    if (i < 0) return 1;
    const n = Number.parseInt(argv[i + 1], 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();

  switch (cmd) {
    case 'rules':
      printRules(opts.json);
      break;

    case 'audit':
      printAudit(days, opts.json);
      break;

    case 'plan':
      if (!prompt) { console.error('用法: plan "任务描述"'); process.exit(1); }
      {
        const plan = await decideWithAudit(prompt);
        if (opts.json) console.log(JSON.stringify(plan, null, 2));
        else printPlan(plan);
        process.exit(plan.ok ? 0 : 1);
      }
      break;

    case 'run':
      if (!prompt) { console.error('用法: run "任务描述"'); process.exit(1); }
      process.exit(await run(prompt, opts));
      break;

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(`
ao-dispatch — AO 任务智能分配（B 关键词 + D 语义兜底）

用法:
  node tools/ao-dispatch.js plan "任务描述"        看决策
  node tools/ao-dispatch.js plan --json "..."      决策输出 JSON
  node tools/ao-dispatch.js run "任务描述"         决策 + 派活
  node tools/ao-dispatch.js run --dry-run "..."    只看会跑什么命令
  node tools/ao-dispatch.js rules                  打印规则表
  node tools/ao-dispatch.js rules --json           规则原文
  node tools/ao-dispatch.js audit                  审计统计（最近 1 天）
  node tools/ao-dispatch.js audit --days 7         审计统计（最近 7 天）
  node tools/ao-dispatch.js audit --days 7 --json  审计统计输出 JSON

改规则:
  直接编辑 tools/ao-dispatch.rules.json，不用改代码。

启用 D 层语义兜底:
  1. 改 rules.json: "semantic": { "enabled": true }
  2. 启动服务: python tools/semantic-router/server.py

审计日志（WAL）:
  每次路由决策写一行 JSON 到 ~/.ao/logs/dispatch/decisions-YYYY-MM-DD.jsonl。
  只记提示词的 sha256 前 16 位与长度，不存原文。
`);
      break;

    default:
      if (cmd && !cmd.startsWith('-')) {
        process.exit(await run([cmd, ...argv.slice(1)].join(' '), opts));
      }
      console.error(`未知命令: ${cmd}`);
      process.exit(1);
  }
}

main();
