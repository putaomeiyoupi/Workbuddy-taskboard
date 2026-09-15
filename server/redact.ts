/**
 * 对外错误信息的**收敛**（脱敏本机路径）
 * ============================================================================
 * 🔴 2026-09-16 加（审计 M4）。`server/index.ts` 里有 **8 处** 500 分支直接回吐
 *    `error.message`，而 better-sqlite3 / fs 的错误信息**经常带本机绝对路径**
 *    （例如 `SQLITE_CANTOPEN: unable to open database file C:\Users\<名字>\…`）。
 *    原样交给客户端，等于把开发机的目录结构与用户名一并吐出去。
 *
 * ⚠️ 只收敛**路径**，不吞掉错误内容本身 —— 用户仍然需要知道"为什么失败"。
 *    把 `C:\Users\me\proj\data\chat.db` 变成 `…\chat.db`，既保留可辨认性
 *    （是哪个文件），又去掉了目录结构。
 *
 * ⚠️ 只处理 **Windows 盘符路径**，刻意不碰 POSIX 风格：
 *    本看板是 Windows 本机应用，而 POSIX 路径正则会**误伤 `/api/tasks` 这类路由文本**
 *    —— 那恰恰是用户排查时需要的上下文。
 */

/**
 * 把错误信息里的 Windows 绝对路径收敛成 `…\文件名`。
 *
 * 覆盖三种形态：
 *   · 盘符路径（反斜杠）`C:\a\b\file.ext` → `…\file.ext`
 *   · 盘符路径（**正斜杠**）`C:/a/b/file.ext` → `…\file.ext`
 *     ⚠️ Node 的很多错误信息用的是正斜杠形式（`fs` 内部会归一化），**不能只匹配反斜杠**
 *     —— 这是单测抓出来的漏网形态。
 *   · UNC 路径 `\\server\share\file.ext` → `…\file.ext`
 */
export function redactLocalPaths(msg: unknown): string {
  return String(msg ?? '')
    .replace(/[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*([^\\/:*?"<>|\r\n]+)/g, '…\\$1')
    .replace(/\\\\[^\\/:*?"<>|\r\n]+\\[^\s"'`,;)]+/g, (m) => {
      const tail = m.split('\\').filter(Boolean).pop();
      return tail ? '…\\' + tail : m;
    });
}

/**
 * 统一的「可安全回给客户端」的错误文案。
 *
 * `fallback` 用于 error 为空 / 不可读时，避免界面上出现 `undefined`。
 */
export function safeErrorMessage(err: unknown, fallback = '操作失败'): string {
  const raw = (err as { message?: unknown })?.message ?? err;
  const text = redactLocalPaths(raw).trim();
  return text || fallback;
}
