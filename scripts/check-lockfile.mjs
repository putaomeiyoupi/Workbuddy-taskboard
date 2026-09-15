/**
 * check-lockfile.mjs —— lockfile 畸形条目守卫
 *
 * 为什么需要它（2026-09-15 实锤）：
 *   本机 npm 有「静默漏解压」的老毛病（详见技能 npm-partial-extract-repair）。
 *   它会给**其它平台的二进制可选依赖**写下一批**没有 version 字段**的占位条目，形如：
 *
 *     "node_modules/esbuild/node_modules/@esbuild/aix-ppc64": { "dev": true, "optional": true }
 *
 *   在 Windows 上本地 `npm install` 能忍，但 **Linux 上的 `npm ci` 直接炸**：
 *
 *     npm error Invalid Version:
 *
 *   ⇒ 表现就是"本地 CI 步骤全绿、推到 GitHub 后 Actions 全红，卡在 `npm ci`"。
 *   实测两库的 CI 首跑就是这么挂的（node 20 / 22 双双 failure，`安装依赖` 失败、后续步骤全 skip）。
 *
 * 判据：`package-lock.json` 的 `packages` 里，除根条目（`""`）外**每条都必须有 version**。
 *
 * 修法（不要删 lockfile 重新生成 —— 那会按 `^` 范围重新解析、可能连带升级一批包）：
 *   只删掉这些畸形条目即可。删条目 ≠ 重新解析 ⇒ 其余包版本**一字不变**。
 *   实测：删 74 条后 `npm ci --dry-run` 通过，且"added 621 packages"与修前一致。
 *
 * 退出码：0 = 通过；1 = 发现畸形条目（附可直接照做的修法）
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
const bad = Object.keys(pkgs).filter(
  (k) => k !== '' && (!pkgs[k] || pkgs[k].version === undefined)
);

if (bad.length === 0) {
  const total = Object.keys(pkgs).filter((k) => k !== '').length;
  console.log(`✅ lockfile 检查通过：${total} 个依赖条目，均带 version`);
  process.exit(0);
}

// 失败：给出可执行的诊断与修法
const esbuild = bad.filter((k) => /@esbuild\//.test(k)).length;
const rollup = bad.filter((k) => /@rollup\//.test(k)).length;
const fsevents = bad.filter((k) => /fsevents$/.test(k)).length;
const other = bad.length - esbuild - rollup - fsevents;

console.error(`❌ package-lock.json 有 ${bad.length} 条**缺 version 的畸形条目**`);
console.error('');
console.error('   这类条目会让 Linux 上的 `npm ci` 直接失败（npm error Invalid Version），');
console.error('   表现为「本地全绿、GitHub Actions 全红」。');
console.error('');
console.error(`   分布：@esbuild/* ${esbuild} 条 · @rollup/* ${rollup} 条 · fsevents ${fsevents} 条 · 其它 ${other} 条`);
console.error('   前几条：');
for (const k of bad.slice(0, 5)) {
  console.error(`     ${k}   ${JSON.stringify(pkgs[k])}`);
}
console.error('');
console.error('   修法（只删畸形条目，不重新解析 ⇒ 不会升级任何依赖版本）：');
console.error('     node scripts/fix-lockfile.mjs          # 删掉它们');
console.error('     npm ci --dry-run                        # 本地验证应通过');
console.error('');
console.error('   若 `scripts/fix-lockfile.mjs` 不存在，手工等价做法：');
console.error('     读 package-lock.json → 删掉 packages 里所有 "version": undefined 且 key 非空的条目 → 写回');
process.exit(1);
