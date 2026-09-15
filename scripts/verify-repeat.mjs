/**
 * 「定期循环」核心算法的用例（纯函数，不依赖数据库/React）
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-repeat.mjs
 *
 * ⚠️ 重点覆盖**失效路径**：月末溢出、跨周、次数上限、有效期边界、无效规格。
 *    这些正是"看起来对、实际跑偏"的地方（本项目踩过太多次：脱敏值守卫、
 *    迁移静默跳过……都是靠专门为失效路径造用例才抓到的）。
 */
import {
  normalizeRepeatSpec,
  normalizeRepeatMode,
  computeNextRun,
  decideAfterRun,
  describeRepeat,
  isRepeating,
} from '../server/repeat.ts';

let pass = 0;
let fail = 0;
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

/** 本地时间构造（用例里显式给本地墙钟，避免受运行环境时区影响判读） */
const L = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const iso = dt => (dt ? dt.toISOString() : null);
const local = dt =>
  dt
    ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
        dt.getDate()
      ).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(
        dt.getMinutes()
      ).padStart(2, '0')}`
    : null;

console.log('一、规格校验（无效输入必须返回 null，不能兜默认值）');
eq('none → null', normalizeRepeatSpec('none', { anything: 1 }), null);
eq('interval every=0 → null（否则死循环）', normalizeRepeatSpec('interval', { every: 0, unit: 'hour' }), null);
eq('interval every=-1 → null', normalizeRepeatSpec('interval', { every: -1, unit: 'hour' }), null);
eq('interval 非法 unit → null', normalizeRepeatSpec('interval', { every: 2, unit: 'week' }), null);
eq('interval 正常', normalizeRepeatSpec('interval', { every: 2, unit: 'hour' }), { every: 2, unit: 'hour' });
eq('periodic 非法 freq → null', normalizeRepeatSpec('periodic', { freq: 'yearly', hour: 8, minute: 0 }), null);
eq('periodic hour=24 → null', normalizeRepeatSpec('periodic', { freq: 'daily', hour: 24, minute: 0 }), null);
eq('periodic minute=60 → null', normalizeRepeatSpec('periodic', { freq: 'daily', minute: 60, hour: 1 }), null);
eq(
  'weekly 没选周几 → null（配了也永远不会跑）',
  normalizeRepeatSpec('periodic', { freq: 'weekly', hour: 8, minute: 0, byDay: [] }),
  null
);
eq(
  'weekly 去重+排序',
  normalizeRepeatSpec('periodic', { freq: 'weekly', hour: 8, minute: 0, byDay: [5, 1, 5, 3] }),
  { freq: 'weekly', hour: 8, minute: 0, byDay: [1, 3, 5] }
);
eq(
  'weekly 丢弃越界周几',
  normalizeRepeatSpec('periodic', { freq: 'weekly', hour: 8, minute: 0, byDay: [1, 9, -2] }),
  { freq: 'weekly', hour: 8, minute: 0, byDay: [1] }
);
eq('monthly 缺 byMonthDay → null', normalizeRepeatSpec('periodic', { freq: 'monthly', hour: 8, minute: 0 }), null);
eq('monthly 0 日 → null', normalizeRepeatSpec('periodic', { freq: 'monthly', hour: 8, minute: 0, byMonthDay: 0 }), null);
eq('monthly 32 日 → null', normalizeRepeatSpec('periodic', { freq: 'monthly', hour: 8, minute: 0, byMonthDay: 32 }), null);
eq('字符串 JSON 可解析', normalizeRepeatSpec('interval', '{"every":3,"unit":"day"}'), { every: 3, unit: 'day' });
eq('坏 JSON 字符串 → null', normalizeRepeatSpec('interval', '{oops'), null);
eq('normalizeRepeatMode 异常值归 none', normalizeRepeatMode('weird'), 'none');
eq('normalizeRepeatMode 保留 interval', normalizeRepeatMode('interval'), 'interval');

console.log('\n二、周期 · 每天');
const daily = { freq: 'daily', hour: 8, minute: 20 };
eq('06:00 → 当天 08:20', local(computeNextRun(daily, L(2026, 9, 15, 6, 0))), '2026-09-15 08:20');
eq('08:20 整（必须严格向后） → 次日', local(computeNextRun(daily, L(2026, 9, 15, 8, 20))), '2026-09-16 08:20');
eq('20:00 → 次日 08:20', local(computeNextRun(daily, L(2026, 9, 15, 20, 0))), '2026-09-16 08:20');
eq('月末 09-30 → 跨月 10-01', local(computeNextRun(daily, L(2026, 9, 30, 20, 0))), '2026-10-01 08:20');
eq('年末 12-31 → 跨年 01-01', local(computeNextRun(daily, L(2026, 12, 31, 20, 0))), '2027-01-01 08:20');

console.log('\n三、周期 · 每周（周三、周五）');
const weekly = { freq: 'weekly', hour: 9, minute: 0, byDay: [3, 5] };
// 2026-09-15 是周二
eq('周二 → 本周三', local(computeNextRun(weekly, L(2026, 9, 15, 10, 0))), '2026-09-16 09:00');
eq('周三 08:00 → 当天 09:00', local(computeNextRun(weekly, L(2026, 9, 16, 8, 0))), '2026-09-16 09:00');
eq('周三 10:00 → 本周五', local(computeNextRun(weekly, L(2026, 9, 16, 10, 0))), '2026-09-18 09:00');
eq('周五 10:00 → 下周三（跨周）', local(computeNextRun(weekly, L(2026, 9, 18, 10, 0))), '2026-09-23 09:00');
const weeklyMon = { freq: 'weekly', hour: 7, minute: 30, byDay: [1] };
eq('周一 08:00 → 下周一', local(computeNextRun(weeklyMon, L(2026, 9, 14, 8, 0))), '2026-09-21 07:30');

console.log('\n四、周期 · 每月（含月末溢出这条失效路径）');
const monthly15 = { freq: 'monthly', hour: 10, minute: 0, byMonthDay: 15 };
eq('09-01 → 09-15', local(computeNextRun(monthly15, L(2026, 9, 1, 0, 0))), '2026-09-15 10:00');
eq('09-15 11:00 → 10-15', local(computeNextRun(monthly15, L(2026, 9, 15, 11, 0))), '2026-10-15 10:00');
eq('12-20 → 次年 01-15（跨年）', local(computeNextRun(monthly15, L(2026, 12, 20, 0, 0))), '2027-01-15 10:00');

const monthly31 = { freq: 'monthly', hour: 10, minute: 0, byMonthDay: 31 };
eq(
  '每月 31 日：2 月必须跳过（不能溢出到 3 月）',
  local(computeNextRun(monthly31, L(2026, 1, 31, 11, 0))),
  '2026-03-31 10:00'
);
eq(
  '每月 31 日：4 月（30 天）也跳过 → 5 月 31',
  local(computeNextRun(monthly31, L(2026, 3, 31, 11, 0))),
  '2026-05-31 10:00'
);
eq(
  '每月 31 日：从 1 月初看，首个是 1 月 31',
  local(computeNextRun(monthly31, L(2026, 1, 1, 0, 0))),
  '2026-01-31 10:00'
);

console.log('\n五、间隔（从结束时刻起算）');
eq('每 30 分钟', local(computeNextRun({ every: 30, unit: 'minute' }, L(2026, 9, 15, 8, 0))), '2026-09-15 08:30');
eq(
  '每 2 小时（跨日）',
  local(computeNextRun({ every: 2, unit: 'hour' }, L(2026, 9, 15, 23, 0))),
  '2026-09-16 01:00'
);
eq('每 3 天', local(computeNextRun({ every: 3, unit: 'day' }, L(2026, 9, 15, 12, 0))), '2026-09-18 12:00');

console.log('\n六、有效期（repeat_until）');
eq(
  '下次早于截止 → 正常排',
  local(computeNextRun(daily, L(2026, 9, 15, 6, 0), L(2026, 9, 30, 23, 59))),
  '2026-09-15 08:20'
);
eq(
  '下次正好等于截止 → 仍排（含端点）',
  local(computeNextRun(daily, L(2026, 9, 15, 6, 0), L(2026, 9, 15, 8, 20))),
  '2026-09-15 08:20'
);
eq(
  '下次晚于截止 → null',
  computeNextRun(daily, L(2026, 9, 30, 9, 0), L(2026, 9, 30, 8, 20)),
  null
);

console.log('\n七、decideAfterRun（本轮结束后的决策）');
const base = { repeat_mode: 'interval', repeat_spec: JSON.stringify({ every: 1, unit: 'hour' }), repeat_until: null, repeat_limit: null, repeat_count: 0 };
eq('首轮结束 → 计数 1、排下一轮', (() => {
  const d = decideAfterRun(base, L(2026, 9, 15, 8, 0));
  return { exhausted: d.exhausted, runsDone: d.runsDone, next: local(d.nextAt) };
})(), { exhausted: false, runsDone: 1, next: '2026-09-15 09:00' });

eq('次数上限=3，第 3 轮结束 → 收尾（reason=limit）', (() => {
  const d = decideAfterRun({ ...base, repeat_limit: 3, repeat_count: 2 }, L(2026, 9, 15, 8, 0));
  return { exhausted: d.exhausted, reason: d.reason, runsDone: d.runsDone, next: d.nextAt };
})(), { exhausted: true, reason: 'limit', runsDone: 3, next: null });

eq('次数上限=3，第 2 轮结束 → 还排（未达上限）', (() => {
  const d = decideAfterRun({ ...base, repeat_limit: 3, repeat_count: 1 }, L(2026, 9, 15, 8, 0));
  return { exhausted: d.exhausted, runsDone: d.runsDone, next: local(d.nextAt) };
})(), { exhausted: false, runsDone: 2, next: '2026-09-15 09:00' });

eq('有效期已过 → 收尾（reason=until）', (() => {
  const d = decideAfterRun(
    {
      ...base,
      // ⚠️ mode 必须跟着一起改成 periodic：只换 spec 而 mode 仍是 interval 属于
      //    「模式与规格不匹配」，会被判 invalid（那是另一条用例，见下）
      repeat_mode: 'periodic',
      repeat_spec: JSON.stringify({ freq: 'daily', hour: 8, minute: 0 }),
      repeat_until: iso(L(2026, 9, 15, 9, 0)),
    },
    L(2026, 9, 15, 10, 0)
  );
  return { exhausted: d.exhausted, reason: d.reason, next: d.nextAt };
})(), { exhausted: true, reason: 'until', next: null });

eq('模式与规格不匹配（mode=interval 但 spec 是周期）→ invalid 而非崩溃', (() => {
  const d = decideAfterRun(
    { ...base, repeat_mode: 'interval', repeat_spec: JSON.stringify({ freq: 'daily', hour: 8, minute: 0 }) },
    L(2026, 9, 15, 8, 0)
  );
  return { exhausted: d.exhausted, reason: d.reason };
})(), { exhausted: true, reason: 'invalid' });

eq('暂停仍需计数与排期（暂停只影响"是否触发"）', (() => {
  const d = decideAfterRun({ ...base, repeat_count: 4 }, L(2026, 9, 15, 8, 0));
  return { exhausted: d.exhausted, runsDone: d.runsDone, hasNext: !!d.nextAt };
})(), { exhausted: false, runsDone: 5, hasNext: true });

eq('非循环任务 → 直接结束', (() => {
  const d = decideAfterRun({ ...base, repeat_mode: 'none' }, L(2026, 9, 15, 8, 0));
  return { exhausted: d.exhausted, next: d.nextAt };
})(), { exhausted: true, next: null });

eq('规格损坏 → 结束且 reason=invalid', (() => {
  const d = decideAfterRun({ ...base, repeat_spec: '{broken' }, L(2026, 9, 15, 8, 0));
  return { exhausted: d.exhausted, reason: d.reason };
})(), { exhausted: true, reason: 'invalid' });

console.log('\n八、描述文案与 isRepeating');
eq('每天', describeRepeat('periodic', { freq: 'daily', hour: 8, minute: 20 }), '每天 08:20');
eq('每周多选（固定顺序）', describeRepeat('periodic', { freq: 'weekly', hour: 9, minute: 0, byDay: [1, 3, 5] }), '每周一、周三、周五 09:00');
eq('每月', describeRepeat('periodic', { freq: 'monthly', hour: 10, minute: 0, byMonthDay: 15 }), '每月 15 日 10:00');
eq('每 2 小时', describeRepeat('interval', { every: 2, unit: 'hour' }), '每 2 小时');
eq('每 30 分钟', describeRepeat('interval', { every: 30, unit: 'minute' }), '每 30 分钟');
eq('不循环', describeRepeat('none', null), '不循环');
eq(
  'isRepeating：配置齐全 → true',
  isRepeating({ repeat_mode: 'periodic', repeat_spec: JSON.stringify(daily), repeat_until: null, repeat_limit: null, repeat_count: 0 }),
  true
);
eq(
  'isRepeating：weekly 但没选周几（坏数据）→ false',
  isRepeating({ repeat_mode: 'periodic', repeat_spec: JSON.stringify({ freq: 'weekly', hour: 8, minute: 0, byDay: [] }), repeat_until: null, repeat_limit: null, repeat_count: 0 }),
  false
);
eq(
  'isRepeating：none → false',
  isRepeating({ repeat_mode: 'none', repeat_spec: null, repeat_until: null, repeat_limit: null, repeat_count: 0 }),
  false
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
