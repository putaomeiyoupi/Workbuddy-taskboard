/**
 * Node 运行时定位与注入
 * ============================================================
 * 本机系统 PATH 里**没有 node**（`C:\Program Files\nodejs` 不存在），
 * 唯一可用的 node 在 WorkBuddy 受管目录下。
 *
 * 这会导致两类故障：
 *  1. Agent SDK 启动 CLI 子进程时回退到**裸命令 `node`** →
 *     `CLI process spawn error: spawn node ENOENT`
 *     （SDK `resolveRuntime()` 的兜底分支：`return { command: 'node' }`）
 *  2. 任何自己 spawn('node') 的子进程（如 CLI serve 执行 job）同样失败
 *
 * 对策是双保险：
 *  - `NODE_EXE`：绝对路径，直接传给 SDK 的 `executable` 选项（精准，不依赖 PATH）
 *  - `ensureNodeOnPath()`：把 node 目录前置进 PATH（兜住无法显式传参的子进程）
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 版本号降序比较。只认前 3 段数字，容忍 `22.22.2-3` 这类带后缀的目录名。
 */
function cmpSemverDesc(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 受管 node 的候选路径，按优先级排列：
 *   ① `current/node.exe` —— "当前默认版本"的指针，语义上就该最优先
 *   ② `versions/*\/node.exe` —— 按**版本号从高到低**（不是目录名字母序！）
 *
 * 🔴 2026-09-15 修：原先这里**硬编码了一个具体版本**
 *   （`.workbuddy/binaries/node/versions/22.22.2-3/node.exe`），**而且排在 `current` 前面**。
 *   后果很隐蔽：把受管 node 从 22 升到 24、并把 `current` 指向 24 之后，
 *   看板 spawn 的 CLI 子进程**仍然用 22** —— 因为那条硬编码路径排在最前，
 *   而旧版本目录不会被自动删除，`fs.existsSync` 依然为真。
 *   ⇒ 不再硬编码任何具体版本号；升级 node 时这里无需改动。
 */
function managedNodeCandidates(): string[] {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node');
  const out: string[] = [path.join(base, 'current', 'node.exe')];
  try {
    const versDir = path.join(base, 'versions');
    const versions = fs
      .readdirSync(versDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name))
      .map(e => e.name)
      .sort(cmpSemverDesc);
    for (const v of versions) out.push(path.join(versDir, v, 'node.exe'));
  } catch {
    // versions 目录不存在（非本机托管环境）⇒ 跳过，靠后面的系统路径兜底
  }
  return out;
}

/** 候选路径：受管 node 优先，其次系统安装位置 */
const CANDIDATES: string[] = [
  ...managedNodeCandidates(),
  'C:/Program Files/nodejs/node.exe',
];

/**
 * 解析 node 可执行文件的绝对路径。
 * 找不到候选时回落到 `process.execPath`（看板自己就是 node 启动的，一定有效）。
 */
export function resolveNodeExecutable(): string {
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
    } catch {
      // 忽略权限等异常，继续尝试下一个
    }
  }
  return process.execPath;
}

/** node 可执行文件绝对路径（模块加载时解析一次） */
export const NODE_EXE: string = resolveNodeExecutable();

/**
 * 模块加载时的 PATH 快照。
 * 用于区分「node 本来就在 PATH 里」还是「由看板注入的」，
 * 避免日志给出误导性的结论。
 */
const ORIGINAL_PATH: string = process.env.PATH || process.env.Path || '';

/** node 所在目录 */
const NODE_DIR = path.dirname(NODE_EXE);

/**
 * 把 node 所在目录前置到 PATH。
 *
 * 幂等：已经在 PATH 里就不重复插入。Windows 大小写敏感，
 * 同时写 `PATH` 与 `Path`，避免子进程只认其中一个。
 */
export function ensureNodeOnPath(): void {
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.env.PATH || process.env.Path || '';
  const parts = current.split(sep).filter(Boolean);

  if (!parts.some(p => p.toLowerCase() === NODE_DIR.toLowerCase())) {
    parts.unshift(NODE_DIR);
  }

  const next = parts.join(sep);
  process.env.PATH = next;
  if (process.platform === 'win32') process.env.Path = next;
}

/**
 * 供日志展示的一句话说明。
 *
 * ⚠️ 必须拿**启动时的原始 PATH** 判断，而不是当前 PATH —— 否则
 * `ensureNodeOnPath()` 注入之后再去查，永远会报告「已在 PATH」，
 * 掩盖了「本机原本没有 node」这个关键事实。
 */
export function describeRuntime(): string {
  const sep = process.platform === 'win32' ? ';' : ':';
  const wasOnPath = ORIGINAL_PATH
    .split(sep)
    .some(p => p && p.toLowerCase() === NODE_DIR.toLowerCase());
  return wasOnPath
    ? `${NODE_EXE} (启动时已在 PATH)`
    : `${NODE_EXE} (启动时不在 PATH，已由看板注入)`;
}

/**
 * 清理从宿主继承来的、会干扰子进程的环境变量
 * ============================================================
 * 看板若由 WorkBuddy 的进程链启动，会继承一批「宿主专用」变量。
 * 其中 `SERVER__PORT` / `SERVER__HOST` 是 **CodeBuddy CLI 的监听端口开关**：
 *
 *   const port = parseInt(process.env.SERVER__PORT || '')
 *             || config.get('cell.server', { port: 3000 }).port;
 *   server.listen(port, process.env.SERVER__HOST || '127.0.0.1');
 *
 * 后果（2026-09-13 实测确认）：继承到 `SERVER__PORT=5978`
 * （正是 WorkBuddy 桌面应用自己占用的端口）后，任何被 SDK / CLI 拉起的
 * 子进程都会尝试监听 5978 → **EADDRINUSE** → 未处理的 Promise rejection
 * → **进程静默挂起、零输出、零日志**。
 *
 * ⚠️ 这个故障极难定位：没有报错、没有日志，表面看像「卡在鉴权」。
 * 排查突破口是 `CODEBUDDY_DEBUG=1`，它才会把这行 unhandled rejection 打出来。
 *
 * 看板自身用 `PORT` 变量，不依赖这两个，直接删除最安全。
 */
export function sanitizeInheritedEnv(): string[] {
  const removed: string[] = [];
  for (const key of ['SERVER__PORT', 'SERVER__HOST']) {
    if (process.env[key] !== undefined) {
      delete process.env[key];
      removed.push(key);
    }
  }
  return removed;
}
