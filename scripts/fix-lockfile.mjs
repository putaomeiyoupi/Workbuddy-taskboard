#!/usr/bin/env node
/**
 * fix-lockfile.mjs —— 让 npm **重新生成**一份完整的 package-lock.json
 *
 * ============================================================================
 * ⚠️ 为什么是"重新生成"而不是"删掉畸形条目"（2026-09-15 实锤的教训）
 * ----------------------------------------------------------------------------
 * 本机 npm 会写出**缺 version 的畸形条目**，形如：
 *   "node_modules/rollup/node_modules/@rollup/rollup-linux-x64-gnu": { "dev": true, "optional": true }
 *
 * 我第一版的修法是"把这些条目删掉" —— 结果是：
 *   · `npm ci` 确实不再报 `Invalid Version:` 了
 *   · 但 CI 紧接着倒在 `npm run build`：
 *     `Cannot find module @rollup/rollup-linux-x64-gnu`
 *   · **因为那些条目根本不是垃圾，是其它平台的原生二进制，只是丢了元数据。**
 *
 * ⇒ 正解是让 npm 重新解析、写出**带完整元数据的全平台条目**：
 *     `@rollup/rollup-linux-x64-gnu` → version / os:["linux"] / cpu:["x64"] 一应俱全。
 *
 * 代价要说清楚：重新解析会按 `package.json` 的 `^` 范围取当前最新 ⇒
 *   **可能有若干条目版本上浮**（本项目实测 18 条，全是补丁/小版本）。
 *   所以本脚本会在写入前打印漂移清单，请你过一眼再决定。
 * ============================================================================
 *
 * 用法：
 *   node scripts/fix-lockfile.mjs            # 生成 → 打印漂移 → 应用（含备份）
 *   node scripts/fix-lockfile.mjs --dry-run  # 只看漂移，不写任何文件
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.KANBAN_CHECK_ROOT || path.join(HERE, '..');
const LOCK = path.join(ROOT, 'package-lock.json');
const PJ = path.join(ROOT, 'package.json');
const DRY = process.argv.includes('--dry-run');

if (!existsSync(PJ)) {
  console.error('找不到 package.json');
  process.exit(1);
}

/* ---------- 1) 在空目录里重新生成 ---------- */
const tmp = path.join(os.tmpdir(), `kanban-lockgen-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
copyFileSync(PJ, path.join(tmp, 'package.json')); // 刻意**不带** package-lock.json
console.log(`在临时目录重新解析（未带旧 lock）：${tmp}`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  execFileSync(npmCmd, ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: tmp,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
} catch (e) {
  console.error('npm install --package-lock-only 失败，中止');
  process.exit(1);
}

const genPath = path.join(tmp, 'package-lock.json');
if (!existsSync(genPath)) {
  console.error('没有生成 package-lock.json，中止');
  process.exit(1);
}
const genRaw = readFileSync(genPath, 'utf8');
const gen = JSON.parse(genRaw);

/* ---------- 2) 前置断言 ---------- */
const gp = gen.packages || {};
const gkeys = Object.keys(gp).filter((k) => k !== '');
const noVer = gkeys.filter((k) => !gp[k] || gp[k].version === undefined);
console.log(`\n  新 lock：${gkeys.length} 条目，缺 version 的 ${noVer.length}`);
if (noVer.length) {
  console.error('  ✗ 新生成的 lock 仍缺 version，异常，中止');
  process.exit(1);
}
for (const n of ['@rollup/rollup-linux-x64-gnu', '@esbuild/linux-x64']) {
  const k = gkeys.find((x) => x.endsWith(n));
  console.log(`  ${k ? '✓' : '✗'} ${n} ${k ? '→ version=' + gp[k].version + ' os=' + JSON.stringify(gp[k].os) : '缺失'}`);
}

/* ---------- 3) 打印漂移 ---------- */
if (existsSync(LOCK)) {
  const cur = JSON.parse(readFileSync(LOCK, 'utf8')).packages || {};
  const drift = [];
  for (const k of gkeys) {
    if (cur[k] && cur[k].version !== gp[k].version) drift.push(`${k}: ${cur[k].version} → ${gp[k].version}`);
  }
  const added = gkeys.filter((k) => !cur[k]).length;
  console.log(`\n  版本漂移：${drift.length} 条；新增条目 ${added} 条`);
  for (const d of drift.slice(0, 25)) console.log(`     ${d}`);
  if (drift.length > 25) console.log(`     …还有 ${drift.length - 25} 条`);
  console.log('  （均在 package.json 的 ^ 范围之内；这是"重新解析"的固有代价）');
}

if (DRY) {
  console.log('\n--dry-run：未写入任何文件');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

/* ---------- 4) 应用（备份 + 回读） ---------- */
if (existsSync(LOCK)) {
  const bak = `${LOCK}.bak-${Date.now()}`;
  writeFileSync(bak, readFileSync(LOCK, 'utf8'), 'utf8');
  console.log(`\n  已备份原 lock：${path.basename(bak)}`);
}
writeFileSync(LOCK, genRaw, 'utf8');

const back = JSON.parse(readFileSync(LOCK, 'utf8'));
const bk = Object.keys(back.packages || {}).filter((k) => k !== '');
const bad = bk.filter((k) => !back.packages[k] || back.packages[k].version === undefined);
console.log(`  回读：${bk.length} 条目，缺 version 的 ${bad.length}${bad.length === 0 ? ' ✓' : ' ✗'}`);

rmSync(tmp, { recursive: true, force: true });
console.log('\n下一步建议：');
console.log('  node scripts/check-lockfile.mjs    # 两条判据都应通过');
console.log('  npm ci --dry-run                   # 应通过');
console.log('  确认无误后删掉那份 .bak');
process.exit(bad.length === 0 ? 0 : 1);
