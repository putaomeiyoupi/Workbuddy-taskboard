/**
 * 看板归类规则的验收脚本（纯函数，不需要起服务）。
 *
 * 覆盖 2026-09-14 的四项需求里最容易被「改一处漏一处」的部分：
 *  1. 任务 → 板块（含新增的 completed 列）
 *  2. 「需要人授权 / 补充输入」→ 待决策（含 waiting_input）
 *  3. 宿主 job 的「等人」判定（state/status/tempo 三个信号）
 *  4. 终态配色不被「已完成」列的统一色盖掉
 *
 * 运行：<node> node_modules/tsx/dist/cli.mjs scripts/verify-board-rules.ts
 *
 * ✅ 2026-09-16 起**已接入门禁**：`ci.yml` 的「守卫与用例」与 `check.cmd` 的 [11] 都会跑它。
 *    （此前它**没有任何执行点** —— 见审计 H5。纯函数、零依赖，接进来几乎没有成本；
 *      在 CI 里靠 Node ≥22.18 的默认类型剥离直接 `node x.ts` 即可。）
 */
import {
  columnOf,
  colorOf,
  isAwaitingApproval,
  jobIsAwaiting,
  jobIsExecuting,
  BOARD_COLUMNS,
  labelOf,
  STATUS_COLOR,
} from '../src/components/board/boardConfig.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`);
}

/** 造一个最小任务（只带归类需要的字段） */
const t = (status: string, run_state?: string | null) =>
  ({ status, run_state: run_state ?? null }) as any;

// ---------- 1. 任务 → 板块 ----------

check('待办 → todo', columnOf(t('todo')) === 'todo');
check('自动化定时 → scheduled', columnOf(t('scheduled')) === 'scheduled');
check('执行中 → running', columnOf(t('in_progress', 'running')) === 'running');
check(
  '等授权 → 待决策',
  columnOf(t('in_progress', 'waiting_approval')) === 'pending_decision',
  `col=${columnOf(t('in_progress', 'waiting_approval'))}`
);
check(
  '等用户补充输入 → 待决策（此前会错误地留在「进行中」）',
  columnOf(t('in_progress', 'waiting_input')) === 'pending_decision',
  `col=${columnOf(t('in_progress', 'waiting_input'))}`
);
check(
  '等待额度仍留在「进行中」（那不是等人，是等额度）',
  columnOf(t('in_progress', 'waiting_quota')) === 'running'
);
check(
  '已完成 / 失败 / 取消 都有归属列（此前是 null，从看板上彻底消失）',
  columnOf(t('done')) === 'completed' &&
    columnOf(t('failed')) === 'completed' &&
    columnOf(t('cancelled')) === 'completed',
  `done=${columnOf(t('done'))} failed=${columnOf(t('failed'))} cancelled=${columnOf(t('cancelled'))}`
);
check(
  '「已完成」列存在且标题正确',
  BOARD_COLUMNS.some(c => c.key === 'completed' && c.title === '已完成'),
  `columns=${BOARD_COLUMNS.map(c => c.key).join(',')}`
);
check('五列齐全（新增 completed 后共 5 列）', BOARD_COLUMNS.length === 5, `count=${BOARD_COLUMNS.length}`);

// ---------- 2. 等人判定（任务侧） ----------

check('isAwaitingApproval 覆盖 waiting_input', isAwaitingApproval(t('in_progress', 'waiting_input')));
check('isAwaitingApproval 不误判执行中', !isAwaitingApproval(t('in_progress', 'running')));
check(
  'labelOf 对两种等待都显示「待决策」',
  labelOf(t('in_progress', 'waiting_input')) === '待决策' &&
    labelOf(t('in_progress', 'waiting_approval')) === '待决策'
);

// ---------- 3. 等人判定（宿主 job 侧） ----------

check(
  'state=blocked → 待决策',
  jobIsAwaiting({ state: 'blocked' }) && !jobIsExecuting({ state: 'blocked' })
);
check(
  'state=working 但 status=waiting → 待决策（这是最容易漏的一类）',
  jobIsAwaiting({ state: 'working', status: 'waiting' }) &&
    !jobIsExecuting({ state: 'working', status: 'waiting' })
);
check(
  'tempo=blocked → 待决策',
  jobIsAwaiting({ state: 'working', tempo: 'blocked' })
);
check(
  'state=working + status=busy → 执行中',
  !jobIsAwaiting({ state: 'working', status: 'busy' }) &&
    jobIsExecuting({ state: 'working', status: 'busy' })
);
check(
  'settled 的 job 不算执行中',
  !jobIsExecuting({ state: 'working', settled: true })
);
check(
  'done/failed/stopped 既不算等人也不算执行中',
  !jobIsAwaiting({ state: 'done' }) &&
    !jobIsExecuting({ state: 'done' }) &&
    !jobIsAwaiting({ state: 'failed' }) &&
    !jobIsAwaiting({ state: 'stopped' })
);

// ---------- 4. 配色：终态不被列色统一 ----------

check(
  '失败任务仍是红色（不被「已完成」列的绿色盖掉）',
  colorOf(t('failed')) === STATUS_COLOR.failed,
  `color=${colorOf(t('failed'))}`
);
check('已完成任务为绿色', colorOf(t('done')) === STATUS_COLOR.done, `color=${colorOf(t('done'))}`);
check(
  '取消任务为灰色',
  colorOf(t('cancelled')) === STATUS_COLOR.cancelled,
  `color=${colorOf(t('cancelled'))}`
);
check(
  '非终态仍跟随所属板块配色',
  colorOf(t('in_progress', 'waiting_approval')) === '#fbbf24',
  `color=${colorOf(t('in_progress', 'waiting_approval'))}`
);

const failed = results.filter(r => !r.ok);
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
for (const f of failed) console.log(`  ❌ ${f.name} —— ${f.detail}`);
process.exit(failed.length ? 1 : 0);
