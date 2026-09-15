/**
 * 定期循环 · 后端集成冒烟（隔离库，绝不碰真实库与宿主库）
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-repeat-integration.mjs
 *
 * 覆盖：
 *   ① 迁移：用**真实库的副本**升级到 v7，验证列齐全 + 旧数据语义不变（一律不循环）
 *   ② 建循环任务 → 仍能按 scheduled 落位
 *   ③ 暂停的循环任务**不被 tick 提升**（这是"暂停"唯一有效的证据）
 *   ④ 未暂停但被前置依赖卡住的循环任务**会被提升为 todo**（证明 ③ 不是"全都提升不了"）
 *   ⑤ rescheduleRepeatAfterRun：计数 +1、排下一轮、达到上限收尾
 *   ⑥ resumeRepeatSchedule：恢复时**重算到未来**（不能沿用已过去的旧时间）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`);
  }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      实际: ${g}\n      期望: ${w}`);
  }
};

// ---------- ① 用真实库副本测迁移 ----------
const REPO = process.cwd();
const REAL_DB = path.join(REPO, 'data', 'chat.db');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-repeat-'));
const tmpDb = path.join(tmpDir, 'chat.db');

console.log('一、迁移（在真实库副本上验证，不动真实库）');
if (fs.existsSync(REAL_DB)) {
  // 用 SQLite 自己的 backup，保证 WAL 内容也一并带过来（直接 copyFile 会丢 WAL 里的改动）
  const src = new Database(REAL_DB, { readonly: true, fileMustExist: true });
  await src.backup(tmpDb);
  src.close();
  console.log(`  真实库副本：${tmpDb}（${(fs.statSync(tmpDb).size / 1024).toFixed(0)} KB）`);
} else {
  console.log('  （无真实库，改用全新库）');
}

process.env.CHAT_DB_PATH = tmpDb;

// 必须在设置 CHAT_DB_PATH 之后再动态导入（ESM 的静态 import 会被提升到赋值之前）
const db = await import('../server/db.ts');
const sched = await import('../server/scheduler.ts');
const repeat = await import('../server/repeat.ts');

{
  const raw = new Database(tmpDb, { readonly: true });
  const ver = raw.prepare('SELECT version FROM schema_meta WHERE singleton = 1').get();
  eq('schema 版本已升到 7（忘了 +1 会让迁移被静默跳过）', ver?.version, 7);
  const cols = raw.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  for (const c of [
    'repeat_mode',
    'repeat_spec',
    'repeat_until',
    'repeat_limit',
    'repeat_count',
    'repeat_paused',
    'repeat_last_at',
  ]) {
    ok(cols.includes(c), `tasks 有 ${c} 列`);
  }
  // 旧数据语义不变：升级后所有历史任务都必须仍是「不循环」
  const bad = raw
    .prepare(`SELECT COUNT(*) n FROM tasks WHERE repeat_mode IS NULL OR repeat_mode <> 'none'`)
    .get();
  eq('历史任务的 repeat_mode 一律为 none（升级不应让旧任务开始循环）', bad.n, 0);
  const pausedBad = raw.prepare(`SELECT COUNT(*) n FROM tasks WHERE repeat_paused <> 0`).get();
  eq('历史任务 repeat_paused 一律为 0', pausedBad.n, 0);
  raw.close();
}

// ---------- 构造任务的辅助 ----------
let seq = 0;
function makeTask(fields) {
  const now = new Date().toISOString();
  const id = `test-${Date.now()}-${seq++}`;
  return db.createTask({
    id,
    title: `冒烟-${id}`,
    prompt: 'demo',
    workspace_id: null,
    model: 'test-model',
    agent_id: null,
    status: 'todo',
    priority: 1,
    scheduled_at: null,
    depends_on: null,
    decision_prompt: null,
    decision_options: null,
    decision_answer: null,
    session_id: null,
    sdk_session_id: null,
    result: null,
    error: null,
    progress_log: null,
    retry_count: 0,
    sort_order: 0,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
    executor: 'local',
    host_session_id: null,
    host_job_id: null,
    isolation: 'shared',
    worktree_path: null,
    wait_reason: null,
    run_state: null,
    scopes: null,
    repeat_mode: 'none',
    repeat_spec: null,
    repeat_until: null,
    repeat_limit: null,
    repeat_count: 0,
    repeat_paused: 0,
    repeat_last_at: null,
    ...fields,
  });
}

const past = new Date(Date.now() - 60_000); // 1 分钟前 ⇒ 已到点
const pastIso = past.toISOString();
const intervalSpec = JSON.stringify({ every: 2, unit: 'hour' });

console.log('\n二、建任务：循环字段确实落库（漏写不会报错，只会"看着循环、实际跑一次"）');
{
  const t = makeTask({
    status: 'scheduled',
    scheduled_at: pastIso,
    repeat_mode: 'interval',
    repeat_spec: intervalSpec,
  });
  const back = db.getTask(t.id);
  eq('repeat_mode 落库', back.repeat_mode, 'interval');
  eq('repeat_spec 落库', back.repeat_spec, intervalSpec);
  eq('repeat_count 初始为 0', back.repeat_count, 0);
  eq('repeat_paused 初始为 0', back.repeat_paused, 0);
  ok(repeat.isRepeating(back), 'isRepeating 判定为真');
}

console.log('\n三、暂停的循环任务不被 tick 提升');
{
  const paused = makeTask({
    status: 'scheduled',
    scheduled_at: pastIso,
    repeat_mode: 'interval',
    repeat_spec: intervalSpec,
    repeat_paused: 1,
  });
  // 对照组：未暂停，但被一个永不完成的前置任务卡住 ⇒ 会被提升为 todo 但不会被派发执行
  const blocker = makeTask({ status: 'todo' });
  const live = makeTask({
    status: 'scheduled',
    scheduled_at: pastIso,
    repeat_mode: 'interval',
    repeat_spec: intervalSpec,
  });
  db.setDependencies(live.id, [blocker.id]);

  sched.runTick();

  eq('暂停的循环任务仍停在 scheduled', db.getTask(paused.id).status, 'scheduled');
  eq('未暂停的循环任务被提升为 todo（证明上一条不是因为"全都提升不了"）', db.getTask(live.id).status, 'todo');
  // 对照组应因依赖未满足而未被派发（不占 in_progress）
  eq('未暂停者因前置未完成而未进入执行', db.getTask(live.id).status, 'todo');
}

console.log('\n四、rescheduleRepeatAfterRun（本轮结束 → 排下一轮 / 收尾）');
{
  const t = makeTask({
    status: 'done',
    finished_at: new Date().toISOString(),
    repeat_mode: 'interval',
    repeat_spec: intervalSpec,
    repeat_count: 0,
  });
  const r1 = sched.rescheduleRepeatAfterRun(t.id);
  const after1 = db.getTask(t.id);
  eq('第 1 轮结束 → rescheduled', r1.rescheduled, true);
  eq('计数 +1', after1.repeat_count, 1);
  eq('回到 scheduled（重新出现在「自动化定时」列）', after1.status, 'scheduled');
  ok(!!after1.scheduled_at && new Date(after1.scheduled_at).getTime() > Date.now(), '下次时间在未来');
  ok(!!after1.repeat_last_at, '记录了上一轮结束时间');

  // 达到上限：limit=2 ⇒ 第 2 轮结束即收尾
  const t2 = makeTask({
    status: 'done',
    finished_at: new Date().toISOString(),
    repeat_mode: 'interval',
    repeat_spec: intervalSpec,
    repeat_count: 1,
    repeat_limit: 2,
  });
  const r2 = sched.rescheduleRepeatAfterRun(t2.id);
  const after2 = db.getTask(t2.id);
  eq('达到次数上限 → 不再排（exhausted）', r2.exhausted, true);
  eq('收尾原因 = limit', r2.reason, 'limit');
  eq('计数停在 2', after2.repeat_count, 2);
  eq('清掉排期以免界面显示过期的下次时间', after2.scheduled_at, null);
  eq('任务保持终态（不会被错误地拉回 scheduled）', after2.status, 'done');

  // 非循环任务不应被本函数影响
  const plain = makeTask({ status: 'done' });
  const r3 = sched.rescheduleRepeatAfterRun(plain.id);
  eq('非循环任务 → 不处理', r3.rescheduled, false);
  eq('非循环任务状态不变', db.getTask(plain.id).status, 'done');
}

console.log('\n五、resumeRepeatSchedule（恢复时必须重算到未来）');
{
  const t = makeTask({
    status: 'scheduled',
    scheduled_at: pastIso, // 暂停期间时间已流逝
    repeat_mode: 'interval',
    repeat_spec: intervalSpec,
    repeat_paused: 1,
  });
  const nextIso = sched.resumeRepeatSchedule(t.id);
  const after = db.getTask(t.id);
  ok(!!nextIso, '返回了新的下次时间');
  ok(new Date(nextIso).getTime() > Date.now(), '新时间是未来（不是沿用已经过去的旧时间）');
  eq('暂停标记已清除', after.repeat_paused, 0);

  /**
   * ⚠️ 恢复后的**正确**行为是「停在 scheduled 等未来那一刻」，
   *   而不是立刻被 tick 提升去补跑 —— 否则用户暂停三天再恢复，会瞬间跑一轮。
   *   所以这里断言的是"没有被立刻补跑"。
   */
  sched.runTick();
  eq('恢复后不会被立刻补跑（仍等未来那一刻）', db.getTask(t.id).status, 'scheduled');

  /**
   * 单独证明「暂停标记确实已清除、晋升通道畅通」：把它按到过去，tick 应当能提升。
   * 若 repeat_paused 没被清掉，这里会失败（阶段 1 会跳过它）。
   *
   * ⚠️ 断言的是「不再停在 scheduled」而不是「= todo」：tick 的阶段 1 提升之后，
   *    阶段 3 只要还有空槽就会**立刻派发** ⇒ 状态进一步变成 `in_progress`。
   *    写死 'todo' 会变成一条脆弱的用例（取决于当时槽位是否占满）。
   */
  db.updateTask(t.id, { scheduled_at: pastIso });
  sched.runTick();
  ok(
    ['todo', 'in_progress'].includes(db.getTask(t.id).status),
    '暂停标记清除后，到点能被 tick 提升（不再停在 scheduled）',
    `实际状态：${db.getTask(t.id).status}`
  );
}

console.log('\n六、任务终态时执行历史被正确收尾（循环排期不能破坏 task_runs）');
{
  const t = makeTask({
    status: 'in_progress',
    run_state: 'starting',
    repeat_mode: 'interval',
    repeat_spec: intervalSpec,
  });
  db.createTaskRun({ taskId: t.id, runState: 'starting' });
  // 模拟 onFinish 的顺序：先落终态（关闭 run），再排下一轮
  db.updateTask(t.id, { status: 'done', result: 'ok', run_state: null, finished_at: new Date().toISOString() });
  const runsAfterFinish = db.listTaskRuns(t.id);
  ok(runsAfterFinish.length === 1, '一轮产生一条 run 记录');
  ok(!!runsAfterFinish[0].finished_at, 'run 已收尾（finished_at 非空）');

  sched.rescheduleRepeatAfterRun(t.id);
  const runsAfterReschedule = db.listTaskRuns(t.id);
  eq('排下一轮不会新增 run（新一轮在真正派发时才开）', runsAfterReschedule.length, 1);
  ok(!!runsAfterReschedule[0].finished_at, '已收尾的 run 不会被重新打开');
  eq('任务回到 scheduled', db.getTask(t.id).status, 'scheduled');
}

// 清理（Windows 上文件句柄未释放会删不掉，best-effort 即可）
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n（临时库已清理）');
} catch {
  console.log(`\n（临时库未能自动清理，可手动删：${tmpDir}）`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
