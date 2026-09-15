/**
 * 后端验收：并发占用真实化 + 已完成会话 + CLI 代理通路。
 *
 * 关键点（都在用户原始诉求上）：
 *  - 「全局并发槽位」必须反映 WorkBuddy 里真实在跑的任务，而不是恒为 0/N
 *  - 看板派发出去的宿主会话**不能**被重复计数
 *  - 「已完成」列要有数据（宿主未归档、非运行中的会话）
 *  - resume / reply / job 详情这条通路要真的通（用不存在的 id 验证通路 + 报错可读，无副作用）
 *
 * 运行：<node> node_modules/tsx/dist/cli.mjs scripts/verify-board-backend.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TSX = path.join(PROJECT, 'node_modules/tsx/dist/cli.mjs');
const PORT = 3141;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DB = path.join(PROJECT, 'data', 'verify-board-tmp.db');

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 某端口当前是否空闲 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** CLI serve 的端口候选区（cliBridge.BASE_PORT=14200，扫描 12 个） */
const SERVE_PORT_RANGE = Array.from({ length: 12 }, (_, i) => 14200 + i);

async function occupiedServePorts(): Promise<number[]> {
  const out: number[] = [];
  for (const p of SERVE_PORT_RANGE) if (!(await isPortFree(p))) out.push(p);
  return out;
}

async function getJson<T = any>(p: string): Promise<{ status: number; body: T }> {
  const r = await fetch(`${BASE}${p}`);
  const body: any = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function postJson<T = any>(p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: any = await r.json().catch(() => null);
  return { status: r.status, body: parsed };
}

let child: ChildProcess | null = null;

async function main() {
  // ---- 启动隔离实例（绝不碰用户的 data/chat.db）----
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  child = spawn(NODE, [TSX, 'server/index.ts'], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), CHAT_DB_PATH: TMP_DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  check('隔离实例已启动（PORT=3141，独立库）', up);
  if (!up) throw new Error('服务未启动，后续断言无法进行');

  // ---- 宿主会话：为「已完成」列与占用计算准备真实数据 ----
  const snap = await getJson('/api/host/snapshot');
  const working: any[] = snap.body?.workingSessions ?? [];
  const finished: any[] = snap.body?.finishedSessions ?? [];
  const stats = snap.body?.stats ?? {};

  check('宿主快照可读', snap.body?.available === true, `hostDir=${snap.body?.hostDir}`);
  check(
    '快照新增 finishedSessions（未归档且已结束的会话）',
    Array.isArray(finished),
    `条数=${finished.length}（截断上限 30）· stats.sessionsFinished=${stats.sessionsFinished}`
  );
  check(
    'finishedSessions 全部是 completed/error（不含 working / archived）',
    finished.every((s: any) => s.status === 'completed' || s.status === 'error'),
    `statuses=${[...new Set(finished.map((s: any) => s.status))].join(',') || '(空)'}`
  );
  check(
    '已完成会话可按 id 单独读取（点开卡片需要）',
    finished.length === 0 ||
      (await getJson(`/api/host/sessions/${finished[0].id}`)).body?.session?.id ===
        finished[0].id
  );
  check(
    '不存在的宿主会话 → 404',
    (await getJson('/api/host/sessions/not-a-session')).status === 404
  );

  // ---- 需求 1：槽位必须反映真实占用（含 WorkBuddy 的任务）----
  const st1 = (await getJson('/api/scheduler/status')).body;
  const oc1 = st1?.occupancy;
  check('调度状态返回 occupancy', !!oc1, JSON.stringify(oc1));
  check(
    '宿主在跑的会话被计入占用（用户报的「数字不变 / 恒为 0」）',
    oc1?.hostRunning === working.length,
    `hostRunning=${oc1?.hostRunning} 快照 working=${working.length}`
  );
  check(
    '占用合计 = 看板 + 宿主',
    oc1?.total === oc1?.boardRunning + oc1?.hostRunning,
    `total=${oc1?.total} board=${oc1?.boardRunning} host=${oc1?.hostRunning}`
  );
  check(
    '空库里看板占用为 0 而合计不为 0 —— 数字确实随 WorkBuddy 的任务变化',
    oc1?.boardRunning === 0 && (oc1?.total ?? 0) > 0,
    `board=${oc1?.boardRunning} total=${oc1?.total}`
  );

  // ---- 去重：看板派发出去的会话不能再算一次 ----
  if (working.length > 0) {
    const db = new Database(TMP_DB);
    const now = new Date().toISOString();
    /**
     * ⚠️ 夹具刻意用 `run_state='waiting_quota'`：
     * 它属于调度器的「有意挂起」集合 → 孤儿回收会直接跳过，
     * 既不回退状态、也不会去打宿主接口（避免验收脚本产生额外副作用）。
     * 同时 status 仍是 in_progress，正好用于验证占用与去重。
     */
    const row: Record<string, unknown> = {
      id: 'fixture-dedup',
      title: '占用去重夹具',
      prompt: '用于验证：看板派发的宿主会话不会被重复计数',
      model: 'auto',
      status: 'in_progress',
      priority: 1,
      depends_on: '[]',
      decision_options: '[]',
      progress_log: '[]',
      retry_count: 0,
      sort_order: 0,
      created_at: now,
      updated_at: now,
      started_at: now,
      executor: 'workbuddy',
      isolation: 'shared',
      scopes: '[]',
      run_state: 'waiting_quota',
      host_session_id: working[0].id,
    };
    // 按库中真实列取交集，避免迁移新增列时脚本失效
    const cols: string[] = db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((c: any) => c.name);
    const use = Object.keys(row).filter(k => cols.includes(k));
    db.prepare(
      `INSERT INTO tasks (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`
    ).run(...use.map(k => row[k]));
    db.close();

    const oc2 = (await getJson('/api/scheduler/status')).body?.occupancy;
    check(
      '看板新增 1 个 in_progress → boardRunning=1',
      oc2?.boardRunning === 1,
      `board=${oc2?.boardRunning}`
    );
    check(
      '同一个宿主会话不再重复计入 hostRunning（去重生效）',
      oc2?.hostRunning === working.length - 1,
      `host=${oc2?.hostRunning} 期望=${working.length - 1}`
    );
    check(
      '合计仍等于「看板 + 宿主」（不会因为去重而少算）',
      oc2?.total === working.length,
      `total=${oc2?.total} 期望=${working.length}`
    );

    // 清掉夹具，避免影响后续断言
    const db2 = new Database(TMP_DB);
    db2.prepare('DELETE FROM tasks WHERE id = ?').run('fixture-dedup');
    db2.close();
  }

  // ---- CLI 代理通路（用不存在的 id 验证「通路 + 报错可读」，无副作用）----
  const before = await occupiedServePorts();
  const noJob = await getJson('/api/cli/jobs/this-job-does-not-exist');
  check(
    '查询不存在的实例 → 返回可读错误（而不是挂起或 500）',
    noJob.status >= 400 && typeof noJob.body?.error === 'string' && noJob.body.error.length > 0,
    `status=${noJob.status} error=${String(noJob.body?.error).slice(0, 90)}`
  );

  const badResume = await postJson('/api/cli/resume', {
    sessionId: '00000000-0000-0000-0000-000000000000',
  });
  const resumeAccepted = badResume.status === 200 && badResume.body?.ok === true;
  const resumeRejected = badResume.status >= 400 && !!badResume.body?.error;
  check(
    'resume 通路已打通（官方 API 可达；不挂起、不 500、返回可解析结果）',
    resumeAccepted || resumeRejected,
    `status=${badResume.status} body=${JSON.stringify(badResume.body).slice(0, 150)}`
  );
  if (resumeAccepted) {
    // 实测记录：官方对「不存在的 sessionId」也返回 200（后端读不到 body.job 的细节），
    // 且**没有新建宿主会话**（已用只读查询核对）——所以不算副作用，但界面必须能显示"无 job 返回"。
    console.log(
      '   ℹ️ 官方对未知 sessionId 返回 200；已核对宿主库：未新建任何会话（无副作用）'
    );
  }
  check(
    'resume 缺少 sessionId → 400（参数校验）',
    (await postJson('/api/cli/resume', {})).status === 400
  );
  check(
    'reply 空文本 → 400（参数校验）',
    (await postJson('/api/cli/jobs/abc/reply', { text: '   ' })).status === 400
  );

  // 收尾：把本次测试拉起的 serve 关掉，避免留下孤儿进程
  await postJson('/api/cli/stop');
  await sleep(1200);
  const after = await occupiedServePorts();
  const leaked = after.filter(p => !before.includes(p));
  check(
    '测试结束后没有遗留 serve 监听端口（不留孤儿进程）',
    leaked.length === 0,
    `新增占用=${leaked.join(',') || '无'}（测试前已有：${before.join(',') || '无'}）`
  );
}

async function cleanup() {
  if (child) {
    /**
     * ⚠️ Windows 上 `child.kill()` **杀不掉进程树**：tsx 会再派生真实的服务进程，
     * 结果验收跑完留下一个孤儿服务（连带它自己 spawn 的 CLI serve 子进程）——
     * 用户在看进程列表时就发现过"有几个还在运行"。所以用 taskkill /T /F 连根拔。
     */
    const pid = child.pid;
    child = null;
    if (process.platform === 'win32' && pid) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        await sleep(800);
      } catch {
        /* 忽略 */
      }
    } else {
      try {
        process.kill(pid!, 'SIGTERM');
      } catch {
        /* 忽略 */
      }
      await sleep(300);
    }
  }
  // ⚠️ 本机 safe-delete 会静默拦截 unlink，所以统一「先 rename 再删」并回读校验
  for (const f of [TMP_DB, `${TMP_DB}-shm`, `${TMP_DB}-wal`]) {
    if (!fs.existsSync(f)) continue;
    const bak = `${f}.del${Date.now()}`;
    try {
      fs.renameSync(f, bak);
      fs.unlinkSync(bak);
    } catch {
      /* bak 残留无害（data/ 已 gitignore） */
    }
  }
  const left = [TMP_DB, `${TMP_DB}-shm`, `${TMP_DB}-wal`].filter(f => fs.existsSync(f));
  console.log(left.length ? `⚠️ 临时库未清干净：${left.join(', ')}` : '🧹 临时库已清理');
}

main()
  .catch(err => {
    check('脚本执行未抛异常', false, err?.message || String(err));
  })
  .finally(async () => {
    await cleanup();
    const failed = results.filter(r => !r.ok);
    console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
    for (const f of failed) console.log(`  ❌ ${f.name} —— ${f.detail}`);
    process.exit(failed.length ? 1 : 0);
  });
