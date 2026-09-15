/**
 * 等服务就绪后自动打开浏览器（start.cmd 的收尾动作）
 * ============================================================================
 * 为什么需要这个助手：
 *   `start.cmd` 会在 3000–3010 里**自动挑一个空闲端口**（3000 常被别的程序占用），
 *   所以每次的地址可能不一样；而服务本身是**前台阻塞运行**的，
 *   脚本没法"在服务跑起来之后再打开浏览器"（那一行永远不会执行到）。
 *   于是：把「等就绪 + 打开浏览器」交给这个后台小助手，它先被拉起、然后服务继续前台跑。
 *
 * 用法：
 *   node scripts/open-browser.mjs <port> [path] [timeoutMs]
 *   node scripts/open-browser.mjs 3001 / 90000
 *
 * 关闭自动打开：设环境变量 KANBAN_NO_BROWSER=1
 *
 * 打开方式（按优先级）：
 *   1. `BROWSER` 环境变量 —— 存在则把 URL 交给它（与 CLI 工具的约定一致，
 *      也让自动化验收能在"不弹真实浏览器"的前提下验证这条通路）
 *   2. Windows: `cmd /c start "" <url>`（`start` 是 cmd 内建命令）
 *   3. macOS: `open` / Linux: `xdg-open`
 */

import { spawn } from 'child_process';

const port = Number(process.argv[2] || 3000);
const urlPath = process.argv[3] && process.argv[3].startsWith('/') ? process.argv[3] : '/';
const timeoutMs = Number(process.argv[4] || 90_000);
const url = `http://localhost:${port}${urlPath}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 探测看板是否就绪：要求 200 且响应体带 "ok" 标记（避免撞上恰好占用该端口的别的程序） */
async function isReady() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const text = await res.text();
    return text.includes('ok');
  } catch {
    return false;
  }
}

/**
 * 调用外部命令打开 URL。
 *
 * ⚠️ **必须等这次的调用真的落地**（等进程退出/超时）再返回：
 * 早先版本用 `detached + unref` 立即退出，结果是「提示已打开」和「浏览器真的被唤起」
 * 之间存在竞态 —— 自动化验收读到的记录文件是空的（写入发生在助手退出之后）。
 * `start` / `open` / `xdg-open` 本身都是**唤起浏览器后立刻返回**，
 * 所以等待不会把脚本卡住；万一某个实现不返回，用 8 秒上限兜住。
 *
 * @returns 实际使用的启动方式（仅用于日志）；失败返回 null
 */
function openUrl(target) {
  const browser = process.env.BROWSER;
  /** BROWSER 可能是 .cmd/.exe/带参数，统一交给 cmd 解析（与 CLI 工具的约定一致） */
  const spec = browser
    ? { how: 'BROWSER', cmd: 'cmd', args: ['/c', browser, target] }
    : process.platform === 'win32'
      ? // 空字符串是窗口标题占位符；没有它 `start` 会把 URL 当标题而不打开
        { how: 'start', cmd: 'cmd', args: ['/c', 'start', '', target] }
      : {
          how: process.platform === 'darwin' ? 'open' : 'xdg-open',
          cmd: process.platform === 'darwin' ? 'open' : 'xdg-open',
          args: [target],
        };

  return new Promise(resolve => {
    let settled = false;
    const done = (how, err) => {
      if (settled) return;
      settled = true;
      if (err) {
        console.warn(`[open] 打开浏览器失败（${err}）—— 请手动访问 ${target}`);
        resolve(null);
      } else {
        resolve(how);
      }
    };

    try {
      const child = spawn(spec.cmd, spec.args, { stdio: 'ignore', windowsHide: true });
      child.on('error', err => done(spec.how, err.message));
      child.on('close', () => done(spec.how, null));
      setTimeout(() => {
        // 兜底：个别实现可能不返回，但**不能**因此拖住退出
        if (!settled) {
          settled = true;
          resolve(spec.how);
        }
      }, 8000).unref?.();
    } catch (err) {
      done(spec.how, err?.message || String(err));
    }
  });
}

async function main() {
  if (process.env.KANBAN_NO_BROWSER) {
    console.log(`[open] 已按 KANBAN_NO_BROWSER 跳过自动打开：${url}`);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (await isReady()) {
      ready = true;
      break;
    }
    await sleep(400);
  }

  if (!ready) {
    console.log(
      `[open] 服务在 ${Math.round(timeoutMs / 1000)} 秒内未就绪，暂不打开浏览器。\n` +
        `       可稍后手动访问：${url}`
    );
    process.exitCode = 1;
    return;
  }

  const how = await openUrl(url);
  if (how) console.log(`[open] 已在浏览器打开：${url}（通过 ${how}）`);
}

void main();
