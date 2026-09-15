#!/usr/bin/env node
/**
 * 提交前安全检查
 * ============================================================
 * 目的：拦住「不该进仓库的东西」和「不该公开的内容」。
 * 设计原则：**宁可误报也不要漏放** —— 命中问题就以非 0 退出，阻止提交。
 *
 * 检查项：
 *   1. 体积     —— 单个文件过大（默认 > 2MB，可通过 MAX_MB 调整）
 *   2. 路径     —— node_modules / dist / data / .worktrees / ui-shots / .workbuddy 等
 *   3. 类型     —— 数据库、日志、编译产物、环境变量文件
 *   4. 内容     —— 疑似密钥（私钥块、常见 token 前缀、内网地址、本机绝对路径）
 *
 * 用法：
 *   node scripts/check-commit.mjs            # 检查「已暂存」的文件（pre-commit 用）
 *   node scripts/check-commit.mjs --all      # 检查「已跟踪 + 未忽略」的全部文件
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_MB = Number(process.env.MAX_MB || 2);
const MAX_BYTES = MAX_MB * 1024 * 1024;

/** 不允许出现在仓库里的路径片段 */
const FORBIDDEN_PATHS = [
  ['node_modules/', '依赖目录'],
  ['dist/', '构建产物'],
  ['data/', '运行时数据库目录'],
  ['.worktrees/', '看板创建的 git 工作树'],
  ['.probe-wt/', '探测临时目录'],
  ['ui-shots/', 'UI 取证截图'],
  ['.workbuddy/', 'Agent 工作记忆（含本机环境细节）'],
];

/** 不允许提交的文件名 / 后缀 */
const FORBIDDEN_FILES = [
  [/(^|\/)\.env(\.|$)/, '.env 环境变量文件（.env.example 例外）'],
  [/\.(db|db-wal|db-shm|sqlite|sqlite3)$/i, '数据库文件'],
  [/\.log$/i, '日志文件'],
  [/^server\/.*\.(js|d\.ts|js\.map)$/, 'tsc 落到源码旁的编译产物（会盖住 .ts）'],
  // Vite 配置解析顺序里 vite.config.js 排在 .ts 之前 —— 产物会盖住 TS 配置
  [/(^|\/)vite\.config\.(js|d\.ts)$/, 'vite.config.ts 的编译产物（会盖住 TS 配置）'],
  [/\.timestamp-[0-9a-z-]+\.mjs$/i, 'Vite 残留的临时文件'],
  [/\.(pem|key|p12|pfx|jks)$/i, '证书 / 私钥文件'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)$/i, 'SSH 私钥'],
];

/** 允许的例外（命中 FORBIDDEN_FILES 但仍可提交） */
const ALLOWLIST = [/(^|\/)\.env\.example$/];

/** 内容里不该出现的东西 */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥块'],
  [/\bBearer\s+[A-Za-z0-9._\-]{20,}/, '硬编码的 Bearer 令牌'],
  [/\b(sk|pk|ghp|gho|github_pat|xoxb|xoxp)-[A-Za-z0-9_\-]{16,}/, '疑似 API Key / 访问令牌'],
  [/\bAKIA[0-9A-Z]{16}\b/, '疑似 AWS Access Key'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, '疑似 JWT'],
  // 本机绝对路径（会泄露发帖人目录结构）；示例路径已用占位符时不会命中
  [/[A-Z]:\\Users\\[^\\\s"']+\\/i, '本机用户绝对路径'],
  [/\/(Users|home)\/[a-z0-9._-]+\//i, '本机用户绝对路径（POSIX）'],
];

/** 文本类文件才做内容检查 */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css',
  '.html', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.cmd', '.bat', '.example',
]);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function listFiles(all) {
  let raw;
  if (all) {
    raw = git(['ls-files', '--cached', '--others', '--exclude-standard']);
  } else {
    raw = git(['diff', '--cached', '--name-only', '--diff-filter=ACM']);
  }
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

const problems = [];
const warnings = [];

function fail(file, reason, detail) {
  problems.push({ file, reason, detail });
}

function warn(file, reason, detail) {
  warnings.push({ file, reason, detail });
}

function checkPath(file) {
  if (ALLOWLIST.some(re => re.test(file))) return true;

  for (const [frag, label] of FORBIDDEN_PATHS) {
    if (file.includes(frag)) {
      fail(file, `路径被禁止（${label}）`, `命中片段 "${frag}"`);
      return false;
    }
  }
  for (const [re, label] of FORBIDDEN_FILES) {
    if (re.test(file)) {
      fail(file, `文件类型被禁止（${label}）`, '');
      return false;
    }
  }
  return true;
}

function checkSizeAndContent(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return; // 已删除的文件
  }
  if (!stat.isFile()) return;

  if (stat.size > MAX_BYTES) {
    fail(
      file,
      `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_MB}MB）`,
      '若确需提交，设置 MAX_MB 环境变量；大文件建议改用 Git LFS 或外部托管'
    );
    return;
  }

  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext) && ext !== '') return;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  // 只扫前 200KB，避免大文件拖慢
  const head = text.slice(0, 200 * 1024);

  for (const [re, label] of SECRET_PATTERNS) {
    const m = head.match(re);
    if (m) {
      // 允许「示例/占位符」写法
      if (PLACEHOLDER_RE.test(m[0])) continue;
      fail(file, `内容疑似敏感（${label}）`, `匹配到：${m[0].slice(0, 60)}`);
      return;
    }
  }
}

/**
 * 命中内容若只是「示例/占位符」写法，则不算泄露。
 * 例：`/Users/username/...`、`C:\Users\<name>\...`、`your-api-key`
 * 这些都是文档里正常的示范，不该阻断提交。
 */
const PLACEHOLDER_RE =
  /example|placeholder|sample|dummy|your[_-]?|username|user[_-]?name|<[^>]*>|xxxx|\*\*\*|\.\.\./i;

function main() {
  const all = process.argv.includes('--all');
  let files;
  try {
    files = listFiles(all);
  } catch (e) {
    console.error('[check-commit] 无法读取 git 文件列表：', e.message);
    console.error('[check-commit] 请确认当前目录是 git 仓库');
    process.exit(2);
  }

  if (files.length === 0) {
    console.log('[check-commit] 没有待检查的文件');
    process.exit(0);
  }

  for (const f of files) {
    if (!checkPath(f)) continue;
    checkSizeAndContent(f);
  }

  const mode = all ? '全部待提交文件' : '已暂存文件';
  console.log(`[check-commit] 检查${mode} ${files.length} 个`);

  if (warnings.length) {
    console.log('\n⚠️  提醒：');
    for (const w of warnings) console.log(`   ${w.file} — ${w.reason}`);
  }

  if (problems.length) {
    console.error('\n❌ 发现 ' + problems.length + ' 个问题，已阻止提交：\n');
    for (const p of problems) {
      console.error(`   ${p.file}`);
      console.error(`     → ${p.reason}${p.detail ? '  ' + p.detail : ''}`);
    }
    console.error('\n如确认无误，请先修正 .gitignore，或把文件从暂存区移除：');
    console.error('   git restore --staged <文件>\n');
    process.exit(1);
  }

  console.log('✅ 检查通过，没有不该提交的内容');
  process.exit(0);
}

main();
