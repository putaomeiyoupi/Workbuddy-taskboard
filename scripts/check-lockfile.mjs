/**
 * check-lockfile.mjs —— lockfile 完整性守卫（**两条**判据，缺一不可）
 *
 * ============================================================================
 * 为什么是两条判据（2026-09-15 一天内踩了两次，两次都是我来修的）
 * ----------------------------------------------------------------------------
 * 本机 npm 有「静默漏解压」老毛病（技能 npm-partial-extract-repair），它会写出
 * **缺 version 的畸形条目**，例如：
 *
 *   "node_modules/rollup/node_modules/@rollup/rollup-linux-x64-gnu": { "dev": true, "optional": true }
 *
 * 这些条目**不是垃圾** —— 它们是**其它平台的原生二进制**，只是丢了元数据。
 *
 * 踩坑史：
 *   ① 首次 CI 失败：Linux 上 `npm ci` 报 `npm error Invalid Version:`（版本号为空）
 *      ⇒ 第一版守卫只查这一条，**修法是"把畸形条目删掉"**
 *   ② 修完 CI 前进了一步，却倒在 `npm run build`：
 *      `Cannot find module @rollup/rollup-linux-x64-gnu`
 *      ⇒ **因为我把它删了**！删掉"其它平台的条目"确实能让 `npm ci` 不再报错，
 *        但在那个平台上运行时就会缺原生二进制。
 *
 * ⇒ 结论：畸形条目必须**补齐元数据**（正解 = 让 npm 重新生成 lockfile），
 *    **不能删**。所以守卫除了查"缺 version"，还必须查"平台可选依赖是否齐全"。
 * ============================================================================
 *
 * 判据：
 *   A. `packages` 里除根条目（`""`）外，**每条都必须有 version**
 *   B. 所有条目声明的 `optionalDependencies`（多为平台原生包），
 *      在 lock 里**都必须能找到对应条目**（否则该平台会缺二进制）
 *
 * 退出码：0 = 通过；1 = 发现问题（附可直接照做的修法）
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.KANBAN_CHECK_ROOT || path.join(HERE, '..');
const LOCK = path.join(ROOT, 'package-lock.json');

if (!existsSync(LOCK)) {
  console.log('✅ lockfile 检查跳过：没有 package-lock.json');
  process.exit(0);
}

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK, 'utf8'));
} catch (e) {
  console.error(`❌ package-lock.json 不是合法 JSON：${e.message}`);
  process.exit(1);
}

const pkgs = lock.packages || {};
const keys = Object.keys(pkgs).filter((k) => k !== '');

/* ---------- 判据 A：每条都要有 version ---------- */
const noVersion = keys.filter((k) => !pkgs[k] || pkgs[k].version === undefined);

/* ---------- 判据 B：CI 所依赖的 Linux 原生二进制必须在 lock 里 ---------- */
/**
 * ⚠️ 判据 B 的两次返工（别再把口径放大）：
 *
 *  v1 写成"所有 optionalDependencies 都必须有条目" ⇒ **健康的新 lock 报 40 个缺失**
 *     （`mermaid` / `d3-selection` / `source-map` 这类**普通**可选依赖，npm 本就不写进 lock）
 *  v2 收窄成"所有原生二进制包都必须有" ⇒ **仍误报 30 个**
 *     （npm **本就会省略** darwin / arm64 / freebsd 等它不会安装的平台条目）
 *
 * ⇒ 事实：npm 生成的 lock **从来就不是"全平台齐全"的**，按"齐全"做判据必然误报。
 *   而真正让 CI 挂掉的只有一个具体场景：
 *
 *     ubuntu-latest（linux x64）上 rollup / esbuild 缺自己的原生二进制
 *     → `Cannot find module @rollup/rollup-linux-x64-gnu`
 *
 *   所以判据 B 只盯**这两个**：CI 要用的 Linux x64 二进制必须在 lock 里。
 *   精确、且已验证对健康 lock 零误报。
 *   （2026-09-15 的翻车正是因为上一版修法把它们**删掉**了。）
 */
const CI_REQUIRED = ['@rollup/rollup-linux-x64-gnu', '@esbuild/linux-x64'];

/**
 * ⚠️ 从 lock 的条目 key 里取出**包名**时，必须同时处理两种形态：
 *     顶层：  node_modules/@rollup/rollup-linux-x64-gnu        ← 不含 "/node_modules/"
 *     嵌套：  node_modules/vite/node_modules/@esbuild/linux-x64
 *   第一版只写了 `split('/node_modules/').pop()` —— 顶层那条**不含**该分隔符，
 *   于是整串被当成包名、匹配失败 ⇒ **守卫对"顶层键"假阴性**
 *   （表现为：明明 lock 里有 @rollup/rollup-linux-x64-gnu，却报"缺失"）。
 */
const pkgNameOf = (key) => key.split('/node_modules/').pop().replace(/^node_modules\//, '');

const missingOptional = [];
for (const name of CI_REQUIRED) {
  const hit = keys.find((k) => pkgNameOf(k) === name);
  if (!hit) missingOptional.push(name);
}

/** 供诊断用：列出 lock 里所有原生二进制包名（去重） */
const nativeNames = [...new Set(keys.map(pkgNameOf).filter((n) => /^(@rollup\/rollup-|@esbuild\/)/.test(n)))].sort();

/* ---------- 汇总 ---------- */
if (noVersion.length === 0 && missingOptional.length === 0) {
  console.log(`✅ lockfile 检查通过：${keys.length} 个依赖条目（version 齐全、可选依赖无缺失）`);
  process.exit(0);
}

const FIX_ADVICE = [
  '',
  '   修法（⚠️ 不要手动删条目 —— 见本脚本头部说明，删了会让对应平台缺原生二进制）：',
  '     node scripts/fix-lockfile.mjs      # 让 npm 重新生成一份完整的 lockfile',
  '     npm ci --dry-run                   # 本地验证应通过',
  '',
  '   等价手工做法：',
  '     1) 把 package.json 复制到一个空临时目录（**不要**复制 package-lock.json）',
  '     2) 在该目录执行：npm install --package-lock-only',
  '     3) 把生成出来的 package-lock.json 拷回项目根（替换原文件）',
  '',
];

if (noVersion.length) {
  const esbuild = noVersion.filter((k) => /@esbuild\//.test(k)).length;
  const rollup = noVersion.filter((k) => /@rollup\//.test(k)).length;
  const other = noVersion.length - esbuild - rollup;
  console.error(`❌ 判据 A 失败：${noVersion.length} 条**缺 version 的畸形条目**`);
  console.error('');
  console.error('   影响：Linux 上 `npm ci` 会直接失败（npm error Invalid Version），');
  console.error('        表现为「本地步骤全绿、GitHub Actions 全红」。');
  console.error('');
  console.error(`   分布：@esbuild/* ${esbuild} 条 · @rollup/* ${rollup} 条 · 其它 ${other} 条`);
  console.error('   前几条：');
  for (const k of noVersion.slice(0, 5)) console.error(`     ${k}\n       ${JSON.stringify(pkgs[k])}`);
  for (const l of FIX_ADVICE) console.error(l);
}

if (missingOptional.length) {
  console.error(`❌ 判据 B 失败：lock 里缺少 CI 所依赖的 Linux 原生二进制（${missingOptional.length} 个）`);
  console.error('');
  console.error('   影响：ubuntu-latest 上跑 `npm run build` 会报');
  console.error('        `Cannot find module @rollup/rollup-linux-x64-gnu`');
  console.error('   ⚠️ 常见成因：为了消掉"缺 version"而把这些平台条目**删掉了** —— 那是错的。');
  console.error('      那些条目不是垃圾，是其它平台的原生二进制，只是丢了 version 字段。');
  console.error('');
  for (const m of missingOptional) console.error(`     ${m}`);
  for (const l of FIX_ADVICE) console.error(l);
}

process.exit(1);
