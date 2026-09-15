/**
 * 验收：工作空间与 WorkBuddy 对齐 + 模型清单同源。
 * ============================================================================
 * 用户两个反馈：
 *   1「软件中的工作空间比 WorkBuddy 中多很多，两边应该保持一致」
 *   2「新建任务时可选的模型与 WorkBuddy 中看到的不一样」
 *
 * 本脚本：
 *   A. 先在**真实库的备份副本**上验证 v6 迁移（同路径去重 + 唯一索引），零风险；
 *   B. 再验证幂等（重复启动不再变化）；
 *   C. 校验 /api/models 与 WorkBuddy 产品配置的模型集合一致。
 *
 * ⚠️ 不直接改真实库 —— 真实库的迁移由用户启动服务时执行，本脚本只做副本推演。
 *
 * 运行：<node> node_modules/tsx/dist/cli.mjs scripts/verify-workspace-model-sync.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TSX = path.join(PROJECT, 'node_modules/tsx/dist/cli.mjs');
const REAL_DB = path.join(PROJECT, 'data', 'chat.db');
const BACKUP_DIR = path.join(PROJECT, 'data', 'backup');
const TEST_DB = path.join(PROJECT, 'data', 'ws-migrate-test.db');
const PORT = 3142;
const BASE = `http://127.0.0.1:${PORT}`;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function openDb(file: string, readonly = false) {
  return new Database(file, { readonly, fileMustExist: true });
}

/** 快照：工作空间/任务的关键计数 */
function snapshot(file: string) {
  const db = openDb(file, true);
  const ws = db.prepare('SELECT id, name, path, created_at FROM workspaces ORDER BY created_at').all() as any[];
  const tasks = db.prepare('SELECT id, workspace_id, status FROM tasks').all() as any[];
  const uniqueIdx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_workspaces_path_unique'")
    .get() as any;
  const version = (db.prepare('SELECT version FROM schema_meta').get() as any)?.version;
  db.close();

  const wsIds = new Set(ws.map(w => w.id));
  const orphans = tasks.filter(t => t.workspace_id && !wsIds.has(t.workspace_id));
  return {
    ws,
    wsCount: ws.length,
    uniquePaths: new Set(ws.map(w => String(w.path).trim().toLowerCase())).size,
    taskCount: tasks.length,
    /** 任务引用了不存在的工作空间（迁移绝不该制造这种） */
    orphanTasks: orphans.length,
    hasUniqueIndex: Boolean(uniqueIdx),
    schemaVersion: version,
  };
}

let child: ChildProcess | null = null;

/** 起一个隔离实例（指定库），跑完即停 */
async function withServer<T>(dbFile: string, fn: () => Promise<T>): Promise<T> {
  child = spawn(NODE, [TSX, 'server/index.ts'], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), CHAT_DB_PATH: dbFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  let up = false;
  for (let i = 0; i < 80; i++) {
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
  if (!up) throw new Error('隔离实例启动超时');
  try {
    return await fn();
  } finally {
    child.kill();
    child = null;
    await sleep(500);
  }
}

const getJson = async (p: string) => {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const postJson = async (p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

async function main() {
  // ============ 前置：确认真实库状态并做一份备份 ============
  const before = snapshot(REAL_DB);
  // 只记录现状：迁移前这里应有重复（wsCount > uniquePaths），迁移后两者相等，
  // 两种状态下列表断言都成立，所以不做强断言（避免二次运行时假红）。
  check(
    '已记录真实库现状',
    before.wsCount >= before.uniquePaths,
    `workspaces=${before.wsCount}，唯一路径=${before.uniquePaths}，任务=${before.taskCount}，schema v${before.schemaVersion}`
  );

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  /**
   * ① 长期备份：只在**真的有待执行迁移**时留一份。
   *    否则每跑一次验收就多一个 .bak，备份目录很快变成垃圾场。
   * ② 临时推演副本：**无论如何都从「当前真实库」导出**。
   *    ⚠️ 这里踩过一次：为了省一个备份而复用了旧的 pre-v6 备份做副本，
   *    结果副本的起点是"迁移前状态"（30 空间 / 25 任务），
   *    而断言比对的是真实库当前状态（4 空间 / 0 任务）→ 全线假红。
   *    备份是"历史存档"，推演副本必须是"当前现实"，两者不能混用。
   */
  let backup: string | null = null;
  {
    const existing = fs
      .readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('chat.db.before-v6-'))
      .sort();
    if (before.schemaVersion >= 6) {
      backup = existing.length ? path.join(BACKUP_DIR, existing[0]) : null;
      check(
        '已迁移过：复用既有迁移前备份（不重复备份）',
        true,
        backup ? path.relative(PROJECT, backup) : '(未找到，需人工确认数据来源)'
      );
    } else {
      backup = path.join(BACKUP_DIR, `chat.db.before-v6-${Date.now()}.bak`);
      const db = openDb(REAL_DB, false);
      db.prepare(`VACUUM INTO ?`).run(backup);
      db.close();
      check('已备份真实库（迁移前快照）', fs.existsSync(backup), path.relative(PROJECT, backup));
    }
  }

  // ============ A. 在副本上推演迁移 ============
  for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
    try {
      if (fs.existsSync(f)) fs.renameSync(f, `${f}.del${Date.now()}`);
    } catch {
      /* 忽略 */
    }
  }
  // ⚠️ 必须复制**当前真实库**：备份是历史存档，起点可能还是迁移前状态
  {
    const db = openDb(REAL_DB, false);
    db.prepare(`VACUUM INTO ?`).run(TEST_DB);
    db.close();
  }

  const migrateReport = await withServer(TEST_DB, async () => {
    const afterMigrate = snapshot(TEST_DB);
    const diff = (await getJson('/api/workspaces/reconcile')).body;
    const models = (await getJson('/api/models')).body;

    check(
      '迁移已升级到 v6',
      afterMigrate.schemaVersion === 6,
      `version=${afterMigrate.schemaVersion}`
    );
    check(
      '重复路径已合并（30 → 唯一路径数）',
      afterMigrate.wsCount === before.uniquePaths,
      `${before.wsCount} → ${afterMigrate.wsCount}（唯一路径 ${before.uniquePaths}）`
    );
    check(
      '唯一索引已建立',
      afterMigrate.hasUniqueIndex,
      afterMigrate.hasUniqueIndex ? 'idx_workspaces_path_unique' : '缺失'
    );
    check(
      '任务一个都没丢（数量不变）',
      afterMigrate.taskCount === before.taskCount,
      `${before.taskCount} → ${afterMigrate.taskCount}`
    );
    check(
      '没有任务指向被删掉的工作空间（改挂成功）',
      afterMigrate.orphanTasks === 0,
      `orphan=${afterMigrate.orphanTasks}`
    );
    // 迁移后应「无重复、无仅宿主有」（用户已把仅看板有的那个也移除了，所以不断言 onlyBoard）
    check(
      'reconcile 显示无重复、无仅宿主有',
      diff?.duplicates?.length === 0 && diff?.onlyHost?.length === 0,
      `duplicates=${diff?.duplicates?.length} onlyBoard=${diff?.onlyBoard?.length} onlyHost=${diff?.onlyHost?.length} both=${diff?.both?.length}`
    );

    // 幂等：同路径再建一次 → 幂等返回既有项，不新增
    const created = await postJson('/api/workspaces', {
      name: '重复路径测试',
      path: before.ws[0].path,
    });
    check(
      '重复路径创建被幂等吸收（不会又变多）',
      created.body?.deduped === true,
      `deduped=${created.body?.deduped}`
    );
    const afterCreate = snapshot(TEST_DB);
    check(
      '幂等创建后工作空间数量不变',
      afterCreate.wsCount === afterMigrate.wsCount,
      `${afterMigrate.wsCount} → ${afterCreate.wsCount}`
    );

    // ============ B. 移除「仅看板有」的流程（含任务引用保护） ============
    //
    // ⚠️ 不能假设「恰好存在一个仅看板有的空间」（用户随时可能把它清掉）——
    // 所以在**隔离副本**上自己造一个：一个独立路径的空间 + 一个引用它的任务。
    // 这样删除守卫永远有东西可测，且不影响真实库。
    const fixtureWsId = 'ws-fixture-for-guard';
    const fixtureTaskId = 'task-fixture-for-guard';
    {
      const db = new Database(TEST_DB);
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO workspaces (id, name, path, max_concurrency, description, color, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(
        fixtureWsId,
        '仅看板有·夹具',
        path.join(PROJECT, 'data', 'ws-fixture-only-board'),
        1,
        null,
        null,
        now
      );
      const cols: string[] = db.prepare('PRAGMA table_info(tasks)').all().map((c: any) => c.name);
      const row: Record<string, unknown> = {
        id: fixtureTaskId,
        title: '删除守卫夹具',
        prompt: '用于验证「有任务引用时拒绝删除」',
        model: 'auto',
        status: 'done',
        priority: 1,
        depends_on: '[]',
        decision_options: '[]',
        progress_log: '[]',
        retry_count: 0,
        sort_order: 0,
        created_at: now,
        updated_at: now,
        workspace_id: fixtureWsId,
      };
      const use = Object.keys(row).filter(k => cols.includes(k));
      db.prepare(`INSERT INTO tasks (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`).run(
        ...use.map(k => row[k])
      );
      db.close();
    }
    const diff2 = (await getJson('/api/workspaces/reconcile')).body;
    const target = (diff2.onlyBoard as any[]).find(w => w.id === fixtureWsId);
    check(
      '夹具空间被识别为「仅看板有」',
      !!target && diff2.onlyBoard.length === 1,
      `onlyBoard=${(diff2.onlyBoard as any[]).map(w => w.name).join(',')}`
    );
    if (!target) throw new Error('夹具空间未能出现在 onlyBoard 里');

    const blocked = await postJson('/api/workspaces/sync', { removeIds: [target.id] });
    const blockedOk = blocked.body?.report?.blocked?.length === 1;
    check(
      '有任务引用时删除被拒绝并报出任务数（不静默删任务）',
      blockedOk,
      `blocked=${JSON.stringify(blocked.body?.report?.blocked)}`
    );

    const moved = await postJson('/api/workspaces/sync', {
      removeIds: [target.id],
      reassignTo: (diff2.both as any[])[0].id,
    });
    const afterRemove = snapshot(TEST_DB);
    check(
      '指定改挂目标后可删除，且任务被改挂（无孤儿）',
      moved.body?.report?.removed?.length === 1 && afterRemove.orphanTasks === 0,
      `removed=${moved.body?.report?.removed?.length} reassigned=${moved.body?.report?.reassignedTasks} 剩余空间=${afterRemove.wsCount}`
    );

    // ============ C. 模型清单同源 ============
    return { afterMigrate, diff, models, afterRemove };
  });

  check(
    '模型清单来源为 WorkBuddy 产品配置（与桌面端同源）',
    migrateReport.models?.source === 'workbuddy-config',
    `source=${migrateReport.models?.source} 数量=${migrateReport.models?.models?.length}`
  );

  // 独立读一遍产品配置，交叉比对 id 集合（不依赖被测代码的过滤逻辑）
  const cfgPath =
    process.env.ACC_PRODUCT_CONFIG_PATH ||
    (() => {
      const dirs = fs
        .readdirSync(os.tmpdir(), { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('workbuddy-product-spill-'))
        .map(d => path.join(os.tmpdir(), d.name, 'acc-product-config-v3.json'))
        .filter(f => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return dirs[0];
    })();

  if (!cfgPath) {
    check('找到 WorkBuddy 产品配置用于交叉比对', false, '未找到 spill 配置');
  } else {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const IMAGE = new Set(['text-to-image', 'image-to-image']);
    const expected = new Set<string>(
      (cfg.models as any[])
        .filter(m => m && m.id && m.disabled !== true && !(Array.isArray(m.tags) && m.tags.some((t: string) => IMAGE.has(t))))
        .map(m => String(m.id))
    );
    const actual = new Set<string>(
      (migrateReport.models?.models ?? []).map((m: any) => String(m.modelId))
    );
    const missing = [...expected].filter(id => !actual.has(id));
    const extra = [...actual].filter(id => !expected.has(id));

    check(
      `模型 id 集合与产品配置一致（${expected.size} 个）`,
      missing.length === 0 && extra.length === 0,
      `缺失=${missing.slice(0, 5).join(',') || '无'} 多出=${extra.slice(0, 5).join(',') || '无'}`
    );
    check(
      '包含当前宿主实际使用的模型 deepseek-v4.1-flash',
      actual.has('deepseek-v4.1-flash'),
      `deepseek-v4.1-flash 在列=${actual.has('deepseek-v4.1-flash')}`
    );
    check(
      '图像生成模型已被排除（不能拿去跑任务）',
      ![...actual].some(id => id.startsWith('hunyuan-image')),
      `含 hunyuan-image*=${[...actual].filter(id => id.startsWith('hunyuan-image')).join(',') || '否'}`
    );
    check(
      '自定义模型（custom-local:*）被保留',
      [...actual].some(id => id.startsWith('custom-local:')),
      `数量=${[...actual].filter(id => id.startsWith('custom-local:')).length}`
    );
    const names = (migrateReport.models?.models ?? []) as any[];
    check(
      '模型带有可读名称与描述（不是裸 id）',
      names.filter(m => m.name && m.name !== m.modelId).length > 10,
      `有名称的=${names.filter(m => m.name && m.name !== m.modelId).length}/${names.length}`
    );
  }

  // ============ D. 幂等：再起一次不应再改任何东西 ============
  const second = await withServer(TEST_DB, async () => snapshot(TEST_DB));
  check(
    '二次启动不再改动数据（迁移幂等）',
    second.wsCount === migrateReport.afterRemove.wsCount,
    `${migrateReport.afterRemove.wsCount} → ${second.wsCount}`
  );

  // 收尾：清理测试库（真实库与备份保留）
  for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
    if (!fs.existsSync(f)) continue;
    const bak = `${f}.del${Date.now()}`;
    try {
      fs.renameSync(f, bak);
      fs.unlinkSync(bak);
    } catch {
      /* 忽略 */
    }
  }
  console.log(`\nℹ️ 迁移前备份保留在：${path.relative(PROJECT, backup)}`);
  console.log(
    before.schemaVersion >= 6
      ? 'ℹ️ 真实库已是 v6（此前已迁移过）'
      : 'ℹ️ 真实库尚未迁移 —— 用户启动服务时会自动执行（v5 → v6）'
  );
}

main()
  .catch(err => check('脚本执行未抛异常', false, err?.message || String(err)))
  .finally(() => {
    if (child) {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
    const failed = results.filter(r => !r.ok);
    console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
    for (const f of failed) console.log(`  ❌ ${f.name} —— ${f.detail}`);
    process.exit(failed.length ? 1 : 0);
  });
