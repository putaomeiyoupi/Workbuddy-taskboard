/**
 * 定期循环 · HTTP 接口冒烟（启动隔离实例，不碰真实库）
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-repeat-api.mjs
 *
 * 重点验证**入口校验**：规格无效必须在 400 挡掉，不能落成"永远不触发的定时任务"。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 3461;
const dbPath = path.join(os.tmpdir(), `kanban-repeat-api-${Date.now()}.db`);

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

const env = {
  ...process.env,
  PORT: String(PORT),
  CHAT_DB_PATH: dbPath,
  KANBAN_NO_BROWSER: '1',
};
const srv = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});

const base = `http://127.0.0.1:${PORT}/api`;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json };
}

/**
 * ⚠️ `GET /tasks` 返回的是**裸数组**（不是 `{tasks:[...]}`）。
 *    写成 `json?.tasks ?? []` 会静默拿到空数组，让"找不到脏数据"这类断言**假通过**。
 *    这里统一取一次，避免每处各踩一遍。
 */
function taskList(json) {
  if (Array.isArray(json)) return json;
  return Array.isArray(json?.tasks) ? json.tasks : [];
}

try {
  // 等就绪
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await wait(300);
  }
  if (!ready) {
    console.log('✗ 服务未能在超时内就绪');
    process.exit(1);
  }

  const mk = extra => ({
    title: '循环冒烟',
    prompt: 'demo',
    model: 'test-model',
    workspace_id: null,
    priority: 1,
    ...extra,
  });

  console.log('一、建任务 · 周期（每天 08:20）');
  {
    const r = await api('POST', '/tasks', mk({
      repeat_mode: 'periodic',
      repeat_spec: { freq: 'daily', hour: 8, minute: 20 },
    }));
    eq('HTTP 200', r.status, 200);
    eq('落在「自动化定时」列', r.json?.status, 'scheduled');
    eq('人话描述', r.json?.repeat_desc, '每天 08:20');
    eq('repeat_spec 返回对象（不是 JSON 字符串）', typeof r.json?.repeat_spec, 'object');
    eq('repeat_mode 落库', r.json?.repeat_mode, 'periodic');
    ok(!!r.json?.scheduled_at, '首次时间由服务端算好（用户不必手填）');
    ok(new Date(r.json.scheduled_at).getTime() > Date.now(), '首次时间在未来');
    eq('初始计数 0', r.json?.repeat_count, 0);
  }

  console.log('\n二、建任务 · 间隔（每 2 小时）+ 次数上限 + 有效期');
  {
    const r = await api('POST', '/tasks', mk({
      repeat_mode: 'interval',
      repeat_spec: { every: 2, unit: 'hour' },
      repeat_limit: 5,
      repeat_until: new Date(Date.now() + 7 * 86400_000).toISOString(),
    }));
    eq('HTTP 200', r.status, 200);
    eq('描述', r.json?.repeat_desc, '每 2 小时');
    eq('次数上限落库', r.json?.repeat_limit, 5);
    ok(!!r.json?.repeat_until, '有效期落库');
  }

  console.log('\n三、入口校验：无效规格必须 400（否则会落成"永远不触发"的任务）');
  {
    const cases = [
      ['weekly 但没选周几', { repeat_mode: 'periodic', repeat_spec: { freq: 'weekly', hour: 8, minute: 0, byDay: [] } }],
      ['hour=24 越界', { repeat_mode: 'periodic', repeat_spec: { freq: 'daily', hour: 24, minute: 0 } }],
      ['freq 非法', { repeat_mode: 'periodic', repeat_spec: { freq: 'yearly', hour: 8, minute: 0 } }],
      ['interval every=0', { repeat_mode: 'interval', repeat_spec: { every: 0, unit: 'hour' } }],
      ['interval unit 非法', { repeat_mode: 'interval', repeat_spec: { every: 1, unit: 'week' } }],
      ['次数上限=0', { repeat_mode: 'interval', repeat_spec: { every: 1, unit: 'hour' }, repeat_limit: 0 }],
      ['次数上限=1.5（非整数）', { repeat_mode: 'interval', repeat_spec: { every: 1, unit: 'hour' }, repeat_limit: 1.5 }],
    ];
    for (const [name, extra] of cases) {
      const r = await api('POST', '/tasks', mk(extra));
      eq(`${name} → 400`, r.status, 400);
    }
    // 拒绝后不应留下脏任务
    const list = await api('GET', '/tasks');
    const dirty = taskList(list.json).filter(
      t => t.title === '循环冒烟' && (t.repeat_mode === 'periodic' || t.repeat_mode === 'interval') && !t.scheduled_at
    );
    eq('被拒绝的请求没有留下"有循环配置却没有排期"的脏数据', dirty.length, 0);
  }

  console.log('\n四、暂停 / 恢复');
  {
    const created = await api('POST', '/tasks', mk({
      repeat_mode: 'interval',
      repeat_spec: { every: 3, unit: 'day' },
    }));
    const id = created.json.id;

    const p1 = await api('POST', `/tasks/${id}/repeat/pause`, { paused: true });
    eq('暂停 200', p1.status, 200);
    eq('repeat_paused = 1', p1.json?.repeat_paused, 1);
    eq('暂停后仍留在「自动化定时」列（配置不丢）', p1.json?.status, 'scheduled');

    const p2 = await api('POST', `/tasks/${id}/repeat/pause`, { paused: false });
    eq('恢复 200', p2.status, 200);
    eq('repeat_paused = 0', p2.json?.repeat_paused, 0);
    ok(
      !!p2.json?.scheduled_at && new Date(p2.json.scheduled_at).getTime() > Date.now(),
      '恢复时重算到未来时刻（不补跑暂停期间积压的轮次）'
    );

    // 非循环任务不能暂停
    const plain = await api('POST', '/tasks', mk({}));
    const p3 = await api('POST', `/tasks/${plain.json.id}/repeat/pause`, { paused: true });
    eq('非循环任务暂停 → 409', p3.status, 409);
  }

  console.log('\n五、改配置 / 关闭循环');
  {
    const created = await api('POST', '/tasks', mk({
      repeat_mode: 'periodic',
      repeat_spec: { freq: 'daily', hour: 9, minute: 0 },
    }));
    const id = created.json.id;

    const upd = await api('POST', `/tasks/${id}/repeat`, {
      repeat_mode: 'periodic',
      repeat_spec: { freq: 'weekly', hour: 7, minute: 30, byDay: [1, 5] },
    });
    eq('改配置 200', upd.status, 200);
    eq('描述已更新', upd.json?.repeat_desc, '每周一、周五 07:30');

    // 无效配置不能改进去
    const bad = await api('POST', `/tasks/${id}/repeat`, {
      repeat_mode: 'periodic',
      repeat_spec: { freq: 'weekly', hour: 7, minute: 30, byDay: [] },
    });
    eq('改配置时无效规格 → 400', bad.status, 400);

    const after = await api('GET', `/tasks/${id}`);
    eq('被拒绝的改配置没有污染已有规则', after.json?.repeat_desc, '每周一、周五 07:30');

    const clr = await api('POST', `/tasks/${id}/repeat`, { repeat_mode: 'none' });
    eq('关闭循环 200', clr.status, 200);
    eq('repeat_mode 归 none', clr.json?.repeat_mode, 'none');
    eq('从「自动化定时」挪回待办（避免"不循环的定时任务"这种矛盾状态）', clr.json?.status, 'todo');
    eq('描述回到「不循环」', clr.json?.repeat_desc, '不循环');
  }

  console.log('\n六、列表接口的形态一致');
  {
    const list = await api('GET', '/tasks');
    const all = taskList(list.json);
    const reps = all.filter(t => t.repeat_mode && t.repeat_mode !== 'none');
    ok(all.length > 0, `列表非空（共 ${all.length} 条）`);
    ok(reps.length > 0, `列表里能找到循环任务（${reps.length} 条）`);
    ok(
      reps.every(t => t.repeat_spec === null || typeof t.repeat_spec === 'object'),
      '列表里的 repeat_spec 一律是对象或 null（不能是 JSON 字符串）'
    );
    ok(reps.every(t => typeof t.repeat_desc === 'string'), '每条循环任务都带人话描述');
  }
} finally {
  srv.kill();
  await wait(300);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* 句柄未释放时留给系统清理 */
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
