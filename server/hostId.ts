/**
 * 宿主 id 的**路径安全**校验（防路径穿越）
 * ============================================================================
 * 🔴 2026-09-16 新增（审计 M1）。`hostTranscript` 与 `hostAdapter` 都会把
 *    **HTTP 传来的 id 直接拼进宿主目录路径**：
 *      · `GET /api/host/sessions/:id/transcript` → `projects/<slug>/<id>.jsonl`
 *      · `GET /api/host/task-items?sessionId=<id>` → `tasks/<id>/`
 *    id 里带 `..` 时，`path.join` 会**把它规范化掉**，于是路径逃出宿主目录，
 *    可以读取磁盘上任意 `*.jsonl`（transcript）或含 `subject` 字段的 `*.json`
 *    （task-items）。单独看是"只读泄露"，但叠加「后端零鉴权」就是未授权读取本机文件。
 *
 * 两道防线（**缺一不可**，任一道单独都不够稳）：
 *   ① **白名单** —— 宿主 id 的实测形态是 uuid（`e36c4845-8b63-418e-bbaf-…`）。
 *      只放行「字母/数字开头 + 字母/数字/`.`/`_`/`-`」，
 *      从根上排除 `/`、`\`、`:` 与 `.`、`..` 这类路径片段。
 *   ② **前缀复核** —— 即便将来 ① 被放宽，也要求 `path.resolve` 之后
 *      仍落在允许的基目录**之内**。纵深防御，不把安全性压在单一判据上。
 *
 * ⚠️ 为什么不是「`path.normalize` 之后看看有没有 `..`」：
 *    规范化会**接受并消解** `..`，我们想要的是**拒绝**这种输入，语义不同。
 *    归一化用于"容忍"，校验用于"拒绝"，别把两者混用。
 */

import path from 'path';

/**
 * 该 id 能否作为**单个路径片段**安全拼接。
 *
 * 拒绝：空串、超长、含 `/` 或 `\`、以 `.` 开头（覆盖 `.` 与 `..`）、
 *       含 `:`（Windows 盘符/ADS）、含通配符、含空白与控制字符。
 */
export function isSafeHostId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 128) return false;
  // 首字符必须是字母或数字 ⇒ `.` / `..` 天然被拒；
  // 字符类不含路径分隔符与冒号，因此 `a/b`、`..\x`、`C:foo` 一并被拒。
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/**
 * 纵深复核：`candidate` 解析后是否确实位于 `baseDir` **内部**。
 *
 * 要求是「基目录里的一个条目」，所以 `candidate === baseDir` 本身返回 `false`。
 * 用 `path.resolve` 而非 `path.join` —— 前者同时处理相对路径与 `..`，
 * 能把任何形式的逃逸统一暴露成"前缀不匹配"。
 */
export function isInsideDir(baseDir: string, candidate: string): boolean {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidate);
  if (target === base) return false;
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
