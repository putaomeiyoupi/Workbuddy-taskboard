#!/usr/bin/env node
/**
 * port-preflight.mjs —— 启动前的端口仲裁（**端口单一真源 + 漂移检测**）
 *
 * 为什么需要它：
 *   看板有两种使用形态 —— ① 浏览器打开 ② 嵌入 WorkBuddy 面板（扩展 iframe 指向
 *   `http://127.0.0.1:<port>/index.html`）。形态 ② 的 URL 里**写死了端口**，
 *   而扩展 manifest **只在宿主启动时扫描一次** ⇒ 端口一旦漂移，面板会白屏且毫无提示。
 *
 * 仲裁规则（优先级从高到低）：
 *   1. 已安装扩展的 manifest 里若声明了 `127.0.0.1:<port>` / `localhost:<port>`
 *      ⇒ 这个端口就是**硬要求**（manifest 是宿主实际要加载的东西，以它为准）
 *      · 与 config/port.txt 不一致 ⇒ 大声警告（这是"改常量忘了重装扩展"的漂移）
 *      · 被占用 ⇒ 报错，并**打印占用者 PID / 进程名**与处置办法
 *   2. 没有扩展声明 ⇒ 用 config/port.txt（默认 47831）
 *   3. 被占用且 `KANBAN_ALLOW_PORT_SHIFT=1` ⇒ 自动换一个空闲端口，并警告"面板将失效"
 *
 * 输出：
 *   - stdout：人类可读的诊断
 *   - 把最终端口写入 %TEMP%\kanban-port.current.txt（供 start.cmd 用 `set /p` 读取；
 *     不放在项目目录里，避免产生需要 gitignore 的产物）
 *   - 退出码：0 = 可以用；1 = 不能用（调用方应中止）
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, '..');
const CONFIG_PORT = path.join(PROJECT, 'config', 'port.txt');
const EXT_ROOT = path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(homedir(), '.workbuddy'), 'extensions');
const PORT_OUT = path.join(tmpdir(), 'kanban-port.current.txt');
const DEFAULT_PORT = 47831;
const ALLOW_SHIFT = process.env.KANBAN_ALLOW_PORT_SHIFT === '1';

const say = (...a) => console.log(...a);

function readConfiguredPort() {
  try {
    const n = parseInt(readFileSync(CONFIG_PORT, 'utf8').trim(), 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  } catch { /* fallthrough */ }
  return DEFAULT_PORT;
}

/** 扫已安装扩展，找 manifest 里声明的 localhost 端口 */
function readExtensionDeclaredPorts() {
  const hits = [];
  let dirs = [];
  try { dirs = readdirSync(EXT_ROOT, { withFileTypes: true }); } catch { return hits; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const mf = path.join(EXT_ROOT, d.name, 'extension.json');
    if (!existsSync(mf)) continue;
    let m;
    try { m = JSON.parse(readFileSync(mf, 'utf8')); } catch { continue; }
    const url = m?.ui?.entry?.url;
    if (typeof url !== 'string') continue;
    const match = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//i);
    if (match) hits.push({ id: m.id || d.name, url, port: parseInt(match[1], 10) });
  }
  return hits;
}

/** 该端口是否已被监听；是则尽力给出占用者 */
function inspectPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'm');
    const m = out.match(re);
    if (!m) return { busy: false };
    const pid = m[1];
    let name = 'unknown';
    try {
      const tl = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = tl.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (first) name = (first.split('","')[0] || '').replace(/^"/, '') || name;
    } catch { /* keep unknown */ }
    return { busy: true, pid, name };
  } catch {
    return { busy: false, note: 'netstat 不可用，跳过占用检测' };
  }
}

/** 真绑定测试（能抓到 netstat 看不到的情况，如权限/预留段） */
async function canBind(port) {
  return await new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code || 'ERROR'));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(null)));
  });
}

async function findFreeNear(startPort, span = 20) {
  for (let p = startPort + 1; p <= startPort + span && p < 65536; p += 1) {
    if (!(await canBind(p))) return p;
  }
  return null;
}

function writePort(port) {
  writeFileSync(PORT_OUT, String(port), 'utf8');
}

// ── 主流程 ────────────────────────────────────────────────────────────
const configured = readConfiguredPort();
const declared = readExtensionDeclaredPorts();

say(`[port] config/port.txt = ${configured}`);
if (declared.length === 0) {
  say('[port] 已安装扩展里没有声明 localhost 端口 ⇒ 宽松模式（沿用自动避让策略）');
} else {
  for (const d of declared) say(`[port] 扩展 "${d.id}" 声明端口 ${d.port}  (${d.url})`);
}

// 硬要求 = manifest 声明（以宿主实际加载的为准）；否则 = 配置常量
const required = declared.length > 0 ? declared[0].port : configured;
if (declared.length > 0 && required !== configured) {
  say('');
  say(`[port] ⚠️  漂移：扩展声明 ${required}，但 config/port.txt 是 ${configured}`);
  say('[port]    以扩展为准（否则面板会白屏）；若想统一，请改 config/port.txt 后重跑扩展安装脚本。');
}

const inspection = inspectPort(required);
const bindErr = await canBind(required);

if (!inspection.busy && !bindErr) {
  say(`[port] OK  ${required} 可用`);
  writePort(required);
  process.exit(0);
}

say('');
say(`[port] ✖ ${required} 不可用`);
if (inspection.busy) {
  say(`[port]   占用者：PID ${inspection.pid}  ${inspection.name}`);
  say(`[port]   查证：netstat -ano | findstr :${required}`);
} else if (bindErr) {
  say(`[port]   绑定失败：${bindErr}（可能是系统预留段 excludedportrange，或权限不足）`);
  say(`[port]   查证：netsh int ipv4 show excludedportrange protocol=tcp`);
}

if (declared.length > 0) {
  // ── 严格模式：面板 URL 写死了这个端口，换端口 = 面板白屏 ──────────────
  say('[port]   注意：已装扩展把面板指向这个端口 ⇒ 换端口会导致**嵌入面板白屏**');
  if (ALLOW_SHIFT) {
    const alt = await findFreeNear(required);
    if (alt) {
      say(`[port]   KANBAN_ALLOW_PORT_SHIFT=1 ⇒ 换用 ${alt}`);
      say(`[port]   ⚠️  嵌入面板将失效（它仍指向 ${required}）；需要时请改 config/port.txt 并重跑扩展安装脚本`);
      writePort(alt);
      process.exit(0);
    }
    say('[port]   附近也没有空闲端口');
  }
  say('');
  say('[port] 处置办法（任选）：');
  say(`[port]   1) 结束占用进程：taskkill /PID ${inspection.pid || '<pid>'} /F`);
  say('[port]   2) 改用别的端口：编辑 config/port.txt 改成空闲端口，然后重跑扩展安装脚本（两处都要改）');
  say('[port]   3) 临时放行避让：set KANBAN_ALLOW_PORT_SHIFT=1 && start.cmd   （嵌入面板会失效）');
  process.exit(1);
}

// ── 宽松模式：没有扩展声明端口（只当普通网页用）⇒ 自动避让，保持原有便利性 ──
const alt = await findFreeNear(required, 20);
if (alt) {
  say(`[port]   未装扩展 ⇒ 自动避让到 ${alt}（面板形态不受影响：它本来就没启用）`);
  writePort(alt);
  process.exit(0);
}
say(`[port]   附近（${required + 1}..${required + 20}）也没有空闲端口`);
say('[port]   处置：编辑 config/port.txt 指定一个空闲端口，或结束占用进程');
process.exit(1);
