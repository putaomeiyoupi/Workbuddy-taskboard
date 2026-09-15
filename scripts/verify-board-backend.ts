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
 *
 * ✅ 2026-09-16 已**按现状重写断言**（审计 H5 的收尾），实测 **18/18 通过**（原 5 项失败全部消除）：
 *    · CLI 代理通路（`/api/cli/jobs|resume|reply`）**已随该通道整体下线**、路由不存在
 *      ⇒ 原先「验通路 + 缺参数 400」的 4 条断言改为**回归守卫**：断言一律 404。
 *        哪天有人把端点加回来，这里会立刻变红，提醒必须补齐配套的参数校验与权限断言。
 *    · 「空库占用」那条原要求 `total > 0`（即宿主此刻有任务在跑）—— 那是**外部环境状态**，
 *      宿主空闲时必然失败、还会把人误导到"占用统计坏了"；改为只断言**看板侧**为 0
 *      （宿主口径自洽另有「合计 = 看板 + 宿主」覆盖）。
 * ⚠️ 仍**不进 CI**：它断言的宿主并发占用依赖**本机真实宿主数据**（`~/.workbuddy`），
 *    CI 上没有 ⇒ 它定位为**本机验收脚本**。
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
  /**
   * ⚠️ 2026-09-16 按现状重写（审计 H5 的收尾）：
   *   原断言是 `boardRunning === 0 && total > 0`，后半句要求**宿主此刻有任务在跑**
   *   —— 那属于**外部环境状态**，不是本看板的契约。宿主空闲时 total 本来就是 0，
   *   实测下这条必然失败，而失败信息（`board=0 total=0`）还会把人误导到"占用统计坏了"。
   *
   *   本脚本真正该保证的契约是「空库 ⇒ **看板侧**占用为 0」；
   *   宿主侧口径是否自洽，已由上面那条「占用合计 = 看板 + 宿主」覆盖。
   *   故这里只断言看板侧，并把 host/total 一并打进 detail 便于观察。
   */
  check(
    '空库里看板占用为 0（宿主侧是否 >0 取决于宿主当前状态，不作为判据）',
    oc1?.boardRunning === 0,
    `board=${oc1?.boardRunning} host=${oc1?.hostRunning} total=${oc1?.total}`
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

  // ---- CLI 代理通路：**已随 CLI 派发通道整体下线** ----
  //
  // ⚠️ 2026-09-16 按现状重写（审计 H5 的收尾）：
  //   这段原先断言 `/api/cli/jobs/:id` 的「可读错误」、`/api/cli/resume` 的
  //   「通路已打通」、以及 resume/reply 的「缺参数 → 400」。但 CLI 派发通道随后
  //   **整体下线**（见 `内部归档`），这些路由已经**不存在** ——
  //   实测 `grep '"/cli/' server/index.ts` 为空，全部返回 404。
  //
  //   ⇒ 保留这段的价值从「验通路」变成**回归守卫**：哪天有人把这些端点加回来，
  //     这里会立刻变红，提醒必须补上配套的参数校验与权限断言，而不是让它悄悄复活。
  const before = await occupiedServePorts();
  const noJob = await getJson('/api/cli/jobs/this-job-does-not-exist');
  check(
    '[已下线] GET /api/cli/jobs/:id → 404（不是挂起，也不是 500）',
    noJob.status === 404,
    `status=${noJob.status}`
  );
  check(
    '[已下线] POST /api/cli/resume → 404',
    (await postJson('/api/cli/resume', { sessionId: '00000000-0000-0000-0000-000000000000' }))
      .status === 404
  );
  check(
    '[已下线] POST /api/cli/resume 缺 sessionId → 404（整条路由已不存在，不再有 400 分支）',
    (await postJson('/api/cli/resume', {})).status === 404
  );
  check(
    '[已下线] POST /api/cli/jobs/:id/reply → 404',
    (await postJson('/api/cli/jobs/abc/reply', { text: '   ' })).status === 404
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
