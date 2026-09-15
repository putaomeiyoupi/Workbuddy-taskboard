/**
 * 静态守卫：**宿主（WorkBuddy）必须保持只读**。
 *
 * 背景：项目铁律「宿主库只读，绝不写 ~/.workbuddy/workbuddy.db」，
 * 而且 2026-09-14 用户明确要求「保证对 WorkBuddy 不写」（因此取消了自动化编辑功能）。
 * 这条边界靠人自觉容易失守（曾实现过定点写 automations 表的模块），所以做成检查。
 *
 * 检查三件事：
 *   1. 打开宿主库时必须带 `readonly: true`
 *   2. 在**触碰宿主上下文的文件里**，不得出现对宿主表的写语句
 *      （INSERT/UPDATE/DELETE/REPLACE/DROP/ALTER ... automations/sessions/...）
 *   3. 不得对被 hostAdapter 判为宿主路径的目录做写文件操作（粗筛 writeFileSync 等）
 *
 * ⚠️ 为什么第 2 条要限定「触碰宿主上下文的文件」：
 * 看板**自己的**库 `data/chat.db` 里也有 `sessions` / `workspaces` 等**同名表**
 * （`server/db.ts` 里全是 `INSERT INTO sessions ...` 这类语句，完全合法）。
 * 若不做限定，`server/db.ts` 会被整片误报成"写宿主表"——
 * 第一版就是这么翻车的（11 条误报全部来自 db.ts）。
 * 判定依据：文件里出现宿主库句柄/路径（`hostDb` / `HOST_DB_PATH` / `workbuddy.db` / `HOST_DIR`）
 * 才算"可能碰得到宿主库"。裸 SQL 打到宿主表的唯一途径就是持有这几样东西。
 *
 * 用法：node scripts/check-host-readonly.mjs   （退出码非 0 = 违反只读边界）
 * 测试钩子：KANBAN_CHECK_ROOT=<dir> 可覆盖扫描目录（用于反向验证守卫本身有效）
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.env.KANBAN_CHECK_ROOT
  ? path.resolve(process.env.KANBAN_CHECK_ROOT)
  : path.resolve(import.meta.dirname, '..', 'server');

/** 宿主的表名（写这些一律违规） */
const HOST_TABLES = [
  'automations',
  'automation_runs',
  'sessions',
  'workspaces',
  'session_usage',
  'buddy_snapshots',
];
const WRITE_SQL =
  /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\s+([a-z_]+)/gi;
/** 以可写方式打开库：`new Database(...)` 里没写 readonly: true 的 */
const DB_OPEN = /new\s+Database\s*\(([\s\S]{0,300}?)\)/g;
/** 宿主上下文标记：出现其一，才能"摸到"宿主库 */
const HOST_CONTEXT = /hostDb|HOST_DB|HOST_DIR|hostDir|workbuddy\.db/;

const problems = [];
let scanned = 0;
let hostContextFiles = 0;

for (const file of fs.readdirSync(ROOT)) {
  if (!/\.ts$/.test(file)) continue;
  const full = path.join(ROOT, file);
  const src = fs.readFileSync(full, 'utf8');
  const lines = src.split('\n');
  const lineOf = idx => src.slice(0, idx).split('\n').length;
  scanned++;

  const touchesHost = HOST_CONTEXT.test(src);
  if (touchesHost) hostContextFiles++;

  // ① 写宿主表的 SQL —— 只在触碰宿主上下文的文件里判定（见文件头说明）
  if (touchesHost) {
    for (const m of src.matchAll(WRITE_SQL)) {
      const table = String(m[2] || '').toLowerCase();
      if (HOST_TABLES.includes(table)) {
        problems.push(
          `server/${file}:${lineOf(m.index)} 出现写宿主表的语句：${m[0].replace(/\s+/g, ' ')}`
        );
      }
    }
  }

  // ② 打开宿主库（路径含 workbuddy.db 或 HOST_DB）必须 readonly
  for (const m of src.matchAll(DB_OPEN)) {
    const args = m[1];
    const isHostDb = /workbuddy\.db|HOST_DB|hostDbPath/i.test(args);
    if (isHostDb && !/readonly\s*:\s*true/.test(args)) {
      problems.push(`server/${file}:${lineOf(m.index)} 打开宿主库时没有 readonly: true`);
    }
  }

  // ③ 粗筛：对宿主目录做写文件操作
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/(writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync)\s*\(/.test(l)) continue;
    const ctx = lines.slice(Math.max(0, i - 6), i + 3).join('\n');
    if (/(HOST_DIR|hostDir\(\)|\.workbuddy)/.test(ctx)) {
      problems.push(`server/${file}:${i + 1} 疑似在宿主目录做写操作：${l.trim().slice(0, 90)}`);
    }
  }
}

// ④ 自检：守卫不能是"空转"的 —— 必须真扫到了宿主上下文文件
if (scanned > 0 && hostContextFiles === 0) {
  problems.push(
    '守卫自检失败：没有扫到任何触碰宿主上下文的文件 —— ' +
      '检查逻辑或目录扫描范围失效（守卫等于空转）'
  );
}

if (problems.length === 0) {
  console.log(
    `✅ 宿主只读检查通过：${scanned} 个文件（其中 ${hostContextFiles} 个触碰宿主上下文），` +
      '没有任何写 WorkBuddy 数据/文件的代码'
  );
  process.exit(0);
}
console.error('❌ 宿主只读检查失败（违反「对 WorkBuddy 不写」）：');
for (const p of problems) console.error('  - ' + p);
process.exit(1);
