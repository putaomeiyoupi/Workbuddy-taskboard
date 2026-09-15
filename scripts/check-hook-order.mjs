/**
 * 静态守卫：React 组件里**不允许**在顶层 early return 之后再调用 hook。
 *
 * 为什么需要它（2026-09-14 同一类错误犯了两次，每次都把整块看板打成白屏）：
 *   `if (!target) return null;` 这类早退会让"关闭态"少执行一部分 hook，
 *   而"打开态"多执行 —— React 直接抛 **#310 Rendered more hooks than during the
 *   previous render**，被 ErrorBoundary 兜成「界面渲染出错」，整个页面不可用。
 *   类型检查**抓不到**它（语法完全合法），只有真正点到那个组件才炸。
 *
 * ── 2026-09-16 增强（审计 P2）─────────────────────────────────────────────
 * 原实现有四处盲区，已用 `.tmpcheck/hook-probe` 探针实测**全部漏检**
 * （探针里放 3 处真实违规，旧守卫照样打印「✅ 通过」、退出码 0）：
 *   ① 只用 `findIndex` 取**每个文件的第一个**组件 —— 第二个组件里的违规看不到；
 *   ② 组件识别只认 `const X: React.FC<` —— 用 `function X()` 声明的组件
 *     会让**整个文件**被跳过（`if (compAt < 0) continue`）；
 *   ③ 早退只认**单行** `if (...) return ...` —— `if (...) {` 换行再 `return`
 *      是语义完全相同的写法，却漏检；
 *   ④ hook 名是**固定白名单**（useState/useEffect/… 那几个）—— 项目自己的
 *      `useTasks`、`useWorkspaces`、`useCountdownClock` 等自定义 hook 不在其中。
 *      但它们**同样是 hook**、同样会触发 #310 ⇒ 漏掉等于把一半风险排除在外。
 *
 * 增强后：识别所有组件（含 `function` 声明）、早退支持块形式、
 * hook 名泛化为「任何 `use` + 大写字母开头的调用」。
 *
 * ⚠️ 为什么仍然**只认组件体顶层（恰好 2 空格缩进）**：文件顶部的**工具函数**
 *    （`if (!x) return '—'`）也长着 2 空格缩进，不限定范围会把它们全报成假阳性
 *    —— 第一版守卫正是这么翻车的。
 *
 * 用法：node scripts/check-hook-order.mjs   （退出码非 0 = 有问题）
 * 测试钩子：KANBAN_HOOK_CHECK_ROOT=<dir> 可覆盖扫描目录（用于反向验证守卫本身有效）
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.env.KANBAN_HOOK_CHECK_ROOT
  ? path.resolve(process.env.KANBAN_HOOK_CHECK_ROOT)
  : path.resolve(import.meta.dirname, '..', 'src');

/**
 * hook 调用：`use` + 大写字母开头。
 * ⚠️ 由固定白名单改为**泛化** —— 自定义 hook（useTasks / useWorkspaces / …）
 *    同样是 hook，漏掉它们等于放任一半的真实风险。
 */
const HOOK_RE = /\buse[A-Z]\w*\s*\(/;

/**
 * 组件起始行。支持三种声明方式（原先只认第一种、且要求必须带泛型参数）：
 *   · `const X: React.FC<Props> = ...` / `const X: FC<Props> = ...`
 *   · `const X: React.FC = ...`（**不带泛型参数** —— 同样是常见写法！）
 *   · `function X(...)` / `export function X(...)` / `export default function X(...)`
 */
const COMPONENT_START_RES = [
  // ⚠️ 用 `\b` 而不是 `\s*<`：要求 `FC<` 会让所有"不带泛型参数"的组件文件被**整片跳过**
  //    —— 这是实测发现的第 ⑤ 个盲区（见 .tmpcheck/hook-probe 的 a/b 两个探针：
  //    它们写成 `React.FC` 后，旧规则与"要求 `<`"的新规则都识别不到）。
  /^(export\s+)?const\s+\w+\s*:\s*(React\.)?(FC|FunctionComponent)\b/,
  /^(export\s+)?(default\s+)?function\s+[A-Z]\w*\s*\(/,
];

/** 只扫描 .tsx（组件），递归 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 第 `i` 行是否是「组件体顶层的早退**起始**」。
 * 两种写法都算（原先只认单行）：
 *   · 单行：`  if (!x) return null;`
 *   · 块形式：`  if (!x) {` 且紧随其后（允许空行/注释）是 `return`
 */
function isEarlyReturnStart(lines, i) {
  const l = lines[i];
  if (!/^ {2}if\s*\(/.test(l)) return false; // 只认组件体顶层（恰好 2 空格）
  if (/\breturn\b/.test(l)) return true;
  if (/\{\s*$/.test(l)) {
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const t = lines[j].trim();
      if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
      return /^return\b/.test(t);
    }
  }
  return false;
}

const problems = [];
let scanned = 0;

for (const file of walk(ROOT)) {
  const rel = path.relative(process.cwd(), file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  // 找出**所有**组件起始行（原先只取第一个）
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (COMPONENT_START_RES.some(re => re.test(lines[i]))) starts.push(i);
  }
  if (starts.length === 0) continue; // 不是组件文件，跳过
  scanned++;

  // 逐个组件分段检查：本段 = 本组件起始行 → 下一个组件起始行（或文件尾）
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    let earlyAt = -1;
    for (let i = from; i < to; i++) {
      if (earlyAt < 0 && isEarlyReturnStart(lines, i)) {
        earlyAt = i;
        continue;
      }
      if (earlyAt >= 0 && HOOK_RE.test(lines[i])) {
        problems.push(
          `${rel}:${i + 1} hook 出现在早退之后（早退在 ${earlyAt + 1} 行）：${lines[i].trim().slice(0, 70)}`
        );
      }
    }
  }
}

// 自检：守卫不能是"空转"的 —— 组件识别规则坏掉时也要能发现
if (scanned === 0) {
  problems.push(
    '守卫自检失败：没有识别到任何组件文件 —— 组件识别规则或扫描目录失效（守卫等于空转）'
  );
}

if (problems.length === 0) {
  console.log(`✅ hook 顺序检查通过：${scanned} 个组件文件，没有 hook 出现在顶层 early return 之后`);
  process.exit(0);
}
console.error('❌ hook 顺序检查失败（会触发 React #310，整页白屏）：');
for (const p of problems) console.error('  - ' + p);
process.exit(1);
