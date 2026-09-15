/**
 * 修改范围（scope）—— 声明式冲突治理
 *
 * 任务可以声明「我只会改这几个文件/目录」。作用有两个：
 *   ① **派发前**：范围重叠的任务不并行跑（同一批文件被两个 agent 同时改）
 *   ② **完成后**：核对实际改动有没有越出声明范围
 *
 * 与「独立工作树」的分工：
 *   worktree  = 物理隔离（各写各的目录，天然不冲突）
 *   scope     = 声明式治理（共享目录模式下，靠声明避免撞车）
 * 两者正交：worktree 模式下不参与范围排队，但仍会核对越界。
 *
 * 校验规则借鉴参照项目 `git_workspace.py` 的 `normalize_scopes`，
 * 其中「Windows 上 `.git ` / `.git.` 绕过」那条是自己写极易漏的点。
 */

import path from 'path';

export class ScopeError extends Error {}

/**
 * 规范化并校验一组修改范围。
 *
 * @param raw      原始输入（未知类型，来自请求体）
 * @param repoRoot 仓库根目录（绝对路径）。为空时只做语法校验，跳过「不越出仓库」检查。
 * @returns 去重并排序后的相对路径列表（统一用 `/` 分隔）
 */
export function normalizeScopes(raw: unknown, repoRoot: string | null): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ScopeError('修改范围必须是路径数组');

  const result = new Set<string>();

  for (const item of raw) {
    if (typeof item !== 'string') throw new ScopeError('修改范围必须是文件或目录路径');

    let value = item.trim().replace(/\\/g, '/');
    if (!value) continue;

    // ---- 语法层面的拒绝 ----
    if (value.startsWith('/')) throw new ScopeError(`修改范围不能用绝对路径：${item}`);
    if (/^[a-zA-Z]:/.test(value)) throw new ScopeError(`修改范围不能带盘符：${item}`);
    if (value.includes(':')) throw new ScopeError(`修改范围不能包含 ":"：${item}`);
    if (value.includes('\x00')) throw new ScopeError('修改范围包含非法字符');
    if (/[*?[\]]/.test(value)) {
      throw new ScopeError(`修改范围不支持通配符，请写明确的文件或目录：${item}`);
    }

    const parts = value.split('/').filter(p => p !== '' && p !== '.');
    if (parts.includes('..')) throw new ScopeError(`修改范围不能越出上级目录：${item}`);
    if (parts.length === 0) throw new ScopeError(`修改范围不能为空：${item}`);

    // ---- 拒绝 Git 内部目录 ----
    // ⚠️ Windows 上 `.git ` / `.git.` / `.GIT` 都会被文件系统当成 `.git`，
    // 所以比较前先 casefold 并剥掉尾部的空格与点。少了这步就是个绕过口子。
    if (parts.some(p => p.toLowerCase().replace(/[ .]+$/, '') === '.git')) {
      throw new ScopeError('修改范围不能包含 Git 内部目录');
    }

    value = parts.join('/');

    // ---- 越界检查：解析后必须仍在仓库内 ----
    if (repoRoot) {
      const resolvedRoot = path.resolve(repoRoot);
      const resolved = path.resolve(resolvedRoot, value);
      const rel = path.relative(resolvedRoot, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new ScopeError(`修改范围越出了仓库：${item}`);
      }
      value = rel.split(path.sep).join('/');
    }

    result.add(value);
  }

  return [...result].sort();
}

/**
 * 两个范围是否重叠。
 *
 * 重叠 = 相等，或一个是另一个的祖先目录（`a` 与 `a/b` 冲突）。
 * 特殊值 `.` 表示「整个仓库」，与任何范围都重叠。
 */
export function scopesOverlap(a: string, b: string, ignoreCase = false): boolean {
  let x = a;
  let y = b;
  if (ignoreCase) {
    x = x.toLowerCase();
    y = y.toLowerCase();
  }
  if (x === '.' || y === '.') return true;
  if (x === y) return true;
  return x.startsWith(y + '/') || y.startsWith(x + '/');
}

/** 两组范围是否任意重叠（空范围 = 不声明，不参与冲突判定） */
export function anyOverlap(
  a: string[],
  b: string[],
  ignoreCase = false
): { overlap: boolean; pair?: [string, string] } {
  if (a.length === 0 || b.length === 0) return { overlap: false };
  for (const x of a) {
    for (const y of b) {
      if (scopesOverlap(x, y, ignoreCase)) return { overlap: true, pair: [x, y] };
    }
  }
  return { overlap: false };
}

/** 实际改动的路径里，哪些越出了声明范围 */
export function outsideScopes(
  changedPaths: string[],
  scopes: string[],
  ignoreCase = false
): string[] {
  if (scopes.length === 0) return [];
  const norm = (p: string) => (ignoreCase ? p.toLowerCase() : p);
  const declared = scopes.map(norm);

  return changedPaths.filter(p => {
    const target = norm(p);
    const covered = declared.some(
      s => s === '.' || target === s || target.startsWith(s + '/')
    );
    return !covered;
  });
}

/** 把范围列表格式化成便于展示/日志的一行 */
export function describeScopes(scopes: string[]): string {
  if (scopes.length === 0) return '未声明';
  if (scopes.length <= 3) return scopes.join('、');
  return `${scopes.slice(0, 3).join('、')} 等 ${scopes.length} 项`;
}
