/**
 * 静态守卫：**宿主（WorkBuddy）必须保持只读**。
 *
 * 背景：项目铁律「宿主库只读，绝不写 ~/.workbuddy/workbuddy.db」，
 * 而且 2026-09-14 用户明确要求「保证对 WorkBuddy 不写」（因此取消了自动化编辑功能）。
 * 这条边界靠人自觉容易失守（曾实现过定点写 automations 表的模块），所以做成检查。
 *
 * ── 2026-09-16 增强（审计 P2）─────────────────────────────────────────────
 * 原实现有三处可以**静默绕过**的盲区 —— 已用 `.tmpcheck/guard-probe` 探针实测全部绕过
 * （探针里放 3 处真实违规，旧守卫照样打印「✅ 通过」，退出码 0）：
 *   ① `fs.readdirSync(ROOT)` **不递归** —— 只扫 `server/` 顶层。
 *      当前 `server/` 恰好没有子目录，属**潜在**失效；一旦按域拆目录就静默失守。
 *   ② `/\.ts$/` **不匹配 `.mts` / `.cts`**（它们结尾是 `mts`/`cts`，不是 `.ts`）
 *      —— 违规代码换个扩展名就绕过。
 *   ③ 上下文门控是**纯文本匹配**：把宿主库句柄经**别名**引入即可绕过。
 *      （反向也成立：注释里无意写到那组词，反而会**误触发**检查 —— 实测踩到过。）
 *
 * 增强后的判定规则：
 *   · **宿主独有表**（automations / automation_runs / session_usage / buddy_snapshots）
 *     —— 看板自己的库里**没有同名表**，所以写它们**不需要任何上下文门控**，一律判违规。
 *     这一条同时把 ③ 补上了：别名导入再也绕不过去。
 *   · **两侧同名表**（sessions / workspaces）—— 看板自己也在写，必须结合上下文判定，
 *     因此**保留关键词门控**（否则 `server/db.ts` 会被整片误报成"写宿主表"，
 *     第一版守卫就是这么翻车的，11 条误报全来自 db.ts）。
 *   · **递归扫描** + 覆盖 `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`。
 *   · 写文件操作的粗筛补上 Promise 版与常见变体（原先只有 `*Sync` 那几个）。
 *
 * 用法：node scripts/check-host-readonly.mjs   （退出码非 0 = 违反只读边界）
 * 测试钩子：KANBAN_CHECK_ROOT=<dir> 可覆盖扫描目录（用于反向验证守卫本身有效）
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.env.KANBAN_CHECK_ROOT
  ? path.resolve(process.env.KANBAN_CHECK_ROOT)
  : path.resolve(import.meta.dirname, '..', 'server');

/** 宿主**独有**的表：看板库里没有同名表 ⇒ 写它们一律违规，**无需**上下文门控 */
const HOST_ONLY_TABLES = [
  'automations',
  'automation_runs',
  'session_usage',
  'buddy_snapshots',
];
/** 两侧**同名**的表：看板自己也在写 ⇒ 必须结合宿主上下文判定，否则整片误报 */
const SHARED_TABLES = ['sessions', 'workspaces'];

const WRITE_SQL =
  /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\s+([a-z_]+)/gi;
/** 以可写方式打开库：`new Database(...)` 里没写 readonly: true 的 */
const DB_OPEN = /new\s+Database\s*\(([\s\S]{0,300}?)\)/g;
/** 宿主上下文标记：出现其一，才"可能"摸到宿主库 */
const HOST_CONTEXT = /hostDb|HOST_DB|HOST_DIR|hostDir|workbuddy\.db/;
/** 写文件操作：含 Promise 版与常见变体（原先只有 *Sync，Promise 版是盲区） */
const WRITE_FS_RE =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|copyFile|copyFileSync|createWriteStream|truncate|truncateSync|chmod|chmodSync)\s*\(/;
/** 待扫描的扩展名：`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` */
const SCAN_EXT_RE = /\.(c|m)?[tj]sx?$/i;

/** 递归收集待扫描文件（跳过 node_modules / .git / 点开头目录） */
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SCAN_EXT_RE.test(e.name)) out.push(full);
  }
  return out;
}

const problems = [];
let scanned = 0;
let hostContextFiles = 0;

for (const full of walk(ROOT)) {
  // 用相对 cwd 的路径报错（原先硬编码 `server/${file}` 前缀，换成别的 ROOT 时会误导）
  const file = path.relative(process.cwd(), full);
  const src = fs.readFileSync(full, 'utf8');
  const lines = src.split('\n');
  const lineOf = idx => src.slice(0, idx).split('\n').length;
  scanned++;

  const touchesHost = HOST_CONTEXT.test(src);
  if (touchesHost) hostContextFiles++;

  // ① 写宿主表的 SQL
  for (const m of src.matchAll(WRITE_SQL)) {
    const table = String(m[2] || '').toLowerCase();
    if (HOST_ONLY_TABLES.includes(table)) {
      problems.push(
        `${file}:${lineOf(m.index)} 写**宿主独有表**（看板库里没有该表，因此无需门控）：${m[0].replace(/\s+/g, ' ')}`
      );
    } else if (touchesHost && SHARED_TABLES.includes(table)) {
      problems.push(
        `${file}:${lineOf(m.index)} 在**触碰宿主上下文**的文件里写同名表：${m[0].replace(/\s+/g, ' ')}`
      );
    }
  }

  // ② 打开宿主库（路径含宿主库名或 HOST_DB）必须 readonly
  for (const m of src.matchAll(DB_OPEN)) {
    const args = m[1];
    const isHostDb = /workbuddy\.db|HOST_DB|hostDbPath/i.test(args);
    if (isHostDb && !/readonly\s*:\s*true/.test(args)) {
      problems.push(`${file}:${lineOf(m.index)} 打开宿主库时没有 readonly: true`);
    }
  }

  // ③ 粗筛：对宿主目录做写文件操作
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!WRITE_FS_RE.test(l)) continue;
    const ctx = lines.slice(Math.max(0, i - 6), i + 3).join('\n');
    if (/(HOST_DIR|hostDir\(\)|\.workbuddy)/.test(ctx)) {
      problems.push(`${file}:${i + 1} 疑似在宿主目录做写操作：${l.trim().slice(0, 90)}`);
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
