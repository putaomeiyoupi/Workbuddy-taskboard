#!/usr/bin/env node
/**
 * fix-lockfile.mjs —— 删掉 package-lock.json 里「缺 version 的畸形条目」
 *
 * 背景与判据见 `scripts/check-lockfile.mjs` 的头部说明。一句话：
 *   本机 npm 会给其它平台的二进制可选依赖写下 `{ "dev": true, "optional": true }`
 *   这种没有 version 的占位条目，Windows 本地能忍，**Linux 的 `npm ci` 直接报
 *   `npm error Invalid Version:`**。
 *
 * ⚠️ 为什么是「删条目」而不是「删 lockfile 重新生成」：
 *   本项目的 `package.json` 依赖全用 `^` 范围。删掉整个 lockfile 后重跑 `npm install`
 *   会按范围**重新解析**，可能一口气升级一批包 ⇒ 引入与本次修复无关的变更。
 *   只删畸形条目则**不触发重新解析**，其余包版本一字不变（实测 621 个包版本无差异）。
 *
 * 用法：
 *   node scripts/fix-lockfile.mjs            # 修复（会先备份）
 *   node scripts/fix-lockfile.mjs --dry-run  # 只看会删什么，不写
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.KANBAN_CHECK_ROOT || path.join(HERE, '..');
const LOCK = path.join(ROOT, 'package-lock.json');
const DRY = process.argv.includes('--dry-run');

if (!existsSync(LOCK)) {
  console.log('没有 package-lock.json，无需修复');
  process.exit(0);
}

const raw = readFileSync(LOCK, 'utf8');
const lock = JSON.parse(raw);
const pkgs = lock.packages || {};

const bad = Object.keys(pkgs).filter(
  (k) => k !== '' && (!pkgs[k] || pkgs[k].version === undefined)
);

if (bad.length === 0) {
  console.log('✅ 没有畸形条目，无需修复');
  process.exit(0);
}

const before = Object.keys(pkgs).length;
console.log(`发现 ${bad.length} 条缺 version 的畸形条目：`);
for (const k of bad.slice(0, 10)) console.log(`   ${k}   ${JSON.stringify(pkgs[k])}`);
if (bad.length > 10) console.log(`   …（共 ${bad.length} 条）`);

if (DRY) {
  console.log('\n--dry-run：未写入任何文件');
  process.exit(0);
}

// 备份（本机 rm 被劫持为 safe-delete，这里用普通写副本，最可靠）
const bak = `${LOCK}.bak-${Date.now()}`;
writeFileSync(bak, raw, 'utf8');

for (const k of bad) delete pkgs[k];
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n', 'utf8');

// 回读校验（本项目铁律：报告成功 ≠ 真的生效）
const back = JSON.parse(readFileSync(LOCK, 'utf8'));
const still = Object.keys(back.packages).filter(
  (k) => k !== '' && (!back.packages[k] || back.packages[k].version === undefined)
);

console.log('');
console.log(`  条目数：${before} → ${Object.keys(back.packages).length}`);
console.log(`  回读仍畸形：${still.length}${still.length === 0 ? ' ✓' : ' ✗'}`);
console.log(`  备份：${path.basename(bak)}`);
console.log('');
console.log('下一步建议：');
console.log('  npm ci --dry-run     # 应通过（含 "added N packages"）');
console.log('  确认无误后再删掉那份 .bak');
process.exit(still.length === 0 ? 0 : 1);
