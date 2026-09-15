/**
 * 静态守卫：React 组件里**不允许**在顶层 early return 之后再调用 hook。
 *
 * 为什么需要它（2026-09-14 同一类错误犯了两次，每次都把整块看板打成白屏）：
 *   `if (!target) return null;` 这类早退会让"关闭态"少执行一部分 hook，
 *   而"打开态"多执行 —— React 直接抛 **#310 Rendered more hooks than during the
 *   previous render**，被 ErrorBoundary 兜成「界面渲染出错」，整个页面不可用。
 *   类型检查**抓不到**它（语法完全合法），只有真正点到那个组件才炸。
 *
 * 规则：找形如 `^  if (...) return ...;` 的**顶层**早退（缩进正好 2 空格），
 *      若其后仍有 `useXxx(` 调用 → 报错。
 *
 * 用法：node scripts/check-hook-order.mjs   （退出码非 0 = 有问题）
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..', 'src');
const HOOK_RE = /\buse(State|Effect|Memo|Ref|Callback|Reducer|Context|DrawerAnimation|LayoutEffect)\s*\(/;
/** 顶层早退：缩进正好 2 个空格（组件体内），且是 return 语句 */
const EARLY_RETURN_RE = /^ {2}if\s*\(.*\)\s*return\b/;
/** 早退之后允许出现的豁免：`use` 开头的自定义 hook 变量声明不算，必须是调用形式 */

/** 只扫描 .tsx（组件），且跳过明显的非组件文件 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 组件函数的起始行：`const Foo: React.FC<...> = ...` / `export const Foo: React.FC<...> = ...`。
 * ⚠️ 必须从组件体开始扫 —— 文件顶部的**工具函数**（`if (!x) return '—'`）也长着 2 空格缩进，
 *    不限定范围会把它们全报成假阳性（第一版就踩了）。
 */
const COMPONENT_START_RE = /^(export\s+)?const\s+\w+\s*:\s*React\.FC</;

const problems = [];
for (const file of walk(ROOT)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const compAt = lines.findIndex(l => COMPONENT_START_RE.test(l));
  if (compAt < 0) continue; // 不是组件文件，跳过
  let earlyAt = -1;
  for (let i = compAt; i < lines.length; i++) {
    if (earlyAt < 0 && EARLY_RETURN_RE.test(lines[i])) earlyAt = i;
    else if (earlyAt >= 0 && HOOK_RE.test(lines[i])) {
      problems.push(
        `${path.relative(process.cwd(), file)}:${i + 1} hook 出现在早退之后（早退在 ${earlyAt + 1} 行）：${lines[i].trim().slice(0, 70)}`
      );
    }
  }
}

if (problems.length === 0) {
  console.log('✅ hook 顺序检查通过：没有 hook 出现在顶层 early return 之后');
  process.exit(0);
}
console.error('❌ hook 顺序检查失败（会触发 React #310，整页白屏）：');
for (const p of problems) console.error('  - ' + p);
process.exit(1);
