/**
 * 看板板块配置
 * 定义四个主板块的标识、标题、配色与语义
 *
 * ⚠️ 自 B 档起，状态分两层（`status` 生命周期 + `run_state` 执行阶段），
 * 板块不再与单一 status 一一对应，而是由 `match()` 谓词判定。
 * 组件请统一用本文件导出的 `columnOf` / `labelOf` / `colorOf` 等助手，
 * 不要自己比较 status 字面量 —— 否则两层模型一改就会散落到处漏改。
 */

import type { BoardColumnKey, Task, TaskStatus } from '../../types';

/** 判定任务属于哪一列所需的最小字段 */
type TaskLike = Pick<Task, 'status'> & Partial<Pick<Task, 'run_state'>>;

export interface BoardColumnConfig {
  key: BoardColumnKey;
  title: string;
  /** 英文副标题，科幻感 */
  subtitle: string;
  /** 主色（CSS 变量名） */
  accentVar: string;
  accent: string;
  accentDim: string;
  description: string;
  /** 任务是否属于本列 */
  match: (task: TaskLike) => boolean;
}

/**
 * 是否处于「等待人工介入」——需要人明确授权、或补充信息才能继续。
 *
 * ⚠️ `waiting_input`（等用户补充输入）必须与 `waiting_approval` 归为同一列：
 * 两者都**卡在人身上**、任务都不会自己往下走，之前把 `waiting_input`
 * 留在「进行中」会让用户以为它还在跑，实际永远等不到结果。
 */
export function isAwaitingApproval(task: TaskLike): boolean {
  return (
    task.status === 'in_progress' &&
    (task.run_state === 'waiting_approval' || task.run_state === 'waiting_input')
  );
}

/** 是否占着执行槽位（进行中，含各种等待） */
export function isActive(task: TaskLike): boolean {
  return task.status === 'in_progress';
}

/**
 * 是否**正在执行**（进行中且不在等人工）。
 * 等价于「属于『进行中』这一列」—— 旧代码里的 `status === 'running'` 应换成它。
 */
export function isExecuting(task: TaskLike): boolean {
  return task.status === 'in_progress' && !isAwaitingApproval(task);
}

/** 是否终态 */
export function isTerminal(task: TaskLike): boolean {
  return task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
}

/** 结果不确定、保留占用待核对 */
export function isUncertain(task: TaskLike): boolean {
  return task.status === 'in_progress' && task.run_state === 'uncertain';
}

export const BOARD_COLUMNS: BoardColumnConfig[] = [
  {
    key: 'todo',
    title: '待办',
    subtitle: 'QUEUE',
    accentVar: '--board-todo',
    accent: '#22d3ee',
    accentDim: 'rgba(34, 211, 238, 0.14)',
    description: '等待调度器分配执行槽位',
    match: t => t.status === 'todo',
  },
  {
    key: 'running',
    title: '进行中',
    subtitle: 'EXECUTING',
    accentVar: '--board-running',
    accent: '#a78bfa',
    accentDim: 'rgba(167, 139, 250, 0.16)',
    description: '正在由 Agent 执行',
    match: t => t.status === 'in_progress' && !isAwaitingApproval(t),
  },
  {
    key: 'pending_decision',
    title: '待决策',
    subtitle: 'AWAITING',
    accentVar: '--board-decision',
    accent: '#fbbf24',
    accentDim: 'rgba(251, 191, 36, 0.16)',
    description: '需要人工确认后继续',
    match: t => isAwaitingApproval(t),
  },
  {
    key: 'scheduled',
    title: '自动化定时',
    subtitle: 'SCHEDULED',
    accentVar: '--board-scheduled',
    accent: '#f472b6',
    accentDim: 'rgba(244, 114, 182, 0.14)',
    description: '到点自动进入待办',
    match: t => t.status === 'scheduled',
  },
  {
    key: 'completed',
    title: '已完成',
    subtitle: 'COMPLETED',
    accentVar: '--board-completed',
    accent: '#34d399',
    accentDim: 'rgba(52, 211, 153, 0.14)',
    description: '已结束的任务与可继续的 WorkBuddy 对话',
    // 终态任务此前会从看板上彻底消失（columnOf 返回 null），
    // 导致「做过什么」不可见、也无法从这里继续或重试。
    match: t => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled',
  },
];

/**
 * 「待决策」配色（琥珀）。
 * 宿主卡片（HostCard）与会话抽屉（HostDrawer）都要用 —— 放在这里做唯一来源，
 * 免得两处各写一份色值、改一处忘一处。
 */
export const AWAIT_ACCENT = '#fbbf24';
export const AWAIT_ACCENT_DIM = 'rgba(251, 191, 36, 0.16)';

/** 优先级配置 */
export const PRIORITY_CONFIG = [
  { value: 0, label: '低', color: '#6b7280' },
  { value: 1, label: '中', color: '#38bdf8' },
  { value: 2, label: '高', color: '#f43f5e' },
] as const;

/** 派生：任务属于哪一列（全覆盖，不再返回 null —— 终态也有归属列） */
export function columnOf(task: TaskLike): BoardColumnKey | null {
  for (const col of BOARD_COLUMNS) {
    if (col.match(task)) return col.key;
  }
  return null;
}

// ============================================================
// 宿主侧（WorkBuddy）的判定
// ============================================================

/**
 * 宿主 job 是否**卡在等人**。
 *
 * 依据官方 HTTP API 的生命周期字段（`state` 持久化 / `status` 即时 / `tempo` 节奏）：
 *   - `state = 'blocked'` —— 持久化生命周期里明确表示「等待人工」
 *   - `status = 'waiting'` —— 存活进程此刻在等输入
 *   - `tempo = 'blocked'` —— 模型活动节奏被阻塞
 * 三者任一命中即视为待决策（宁可多提示，也不要让用户以为它在跑）。
 *
 * ⚠️ **刻意不把 `status='idle'` 算作等人**：官方把 `waiting`（等输入）与
 * `idle`（此刻没在忙）分得很清楚，而一次回合内部的工具间隙也会短暂出现 `idle`
 * —— 若算进来，卡片会在「进行中 / 待决策」之间每个轮询周期反复横跳。
 * 一个真正空闲等待下一条指令的实例，用户点开抽屉即可直接输入要求（见 HostDrawer）。
 */
export function jobIsAwaiting(job: Pick<HostJobLike, 'state' | 'status' | 'tempo'>): boolean {
  return job.state === 'blocked' || job.status === 'waiting' || job.tempo === 'blocked';
}

/**
 * 细分「等人的哪一类」，用于给用户更准确的提示（两者都归「待决策」列）：
 *   - `confirm`：实例明确被阻塞/等确认（`state=blocked` 或 `tempo=blocked`）
 *   - `input`  ：实例空闲待命、等你的下一条指令（`status=waiting`，如刚 resume 出来还没交代要求）
 * 全都算「等人」，但文案不该一样 —— 否则用户会以为"它在问我什么"，实际只是闲着呢。
 */
export function jobAwaitKind(
  job: Pick<HostJobLike, 'state' | 'status' | 'tempo'>
): 'confirm' | 'input' | null {
  if (job.state === 'blocked' || job.tempo === 'blocked') return 'confirm';
  if (job.status === 'waiting') return 'input';
  return null;
}

/** job 是否仍在占用执行资源（活着且没在等人） */
export function jobIsExecuting(job: Pick<HostJobLike, 'state' | 'status' | 'tempo' | 'settled'>): boolean {
  return job.state === 'working' && job.settled !== true && !jobIsAwaiting(job);
}

/** `jobIsAwaiting` 需要的最小字段集（避免与 types.ts 循环依赖） */
export interface HostJobLike {
  state: string;
  status?: string;
  tempo?: string;
  settled?: boolean;
}

/** 生命周期状态 → 中文标签（不含「待决策」这类执行阶段的细分） */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  scheduled: '自动化定时',
  done: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

/** 生命周期状态 → 颜色 */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  todo: '#22d3ee',
  in_progress: '#a78bfa',
  scheduled: '#f472b6',
  done: '#34d399',
  failed: '#f87171',
  cancelled: '#64748b',
};

/**
 * 展示用标签：把执行阶段的细分也算进去。
 * `waiting_approval` 显示为「待决策」，与看板列保持一致。
 */
export function labelOf(task: TaskLike): string {
  if (isAwaitingApproval(task)) return '待决策';
  if (task.run_state === 'uncertain') return '待核对';
  if (task.run_state === 'waiting_quota') return '等待额度';
  return STATUS_LABEL[task.status] ?? task.status;
}

/**
 * 展示用颜色：跟随所属板块，但**终态用状态色**。
 *
 * ⚠️ 终态之所以要特判：它们现在统一归属「已完成」列，
 * 若一律取列色，失败（红）与取消（灰）都会被染成绿色，
 * 一眼看不出哪些是没成功的。
 */
export function colorOf(task: TaskLike): string {
  if (isTerminal(task)) return STATUS_COLOR[task.status] ?? '#22d3ee';
  const col = columnOf(task);
  if (col) {
    const cfg = BOARD_COLUMNS.find(c => c.key === col);
    if (cfg) return cfg.accent;
  }
  return STATUS_COLOR[task.status] ?? '#22d3ee';
}

/** 从状态取板块配色（兼容旧调用，新代码请用 colorOf） */
export function accentOfStatus(status: TaskStatus): string {
  return STATUS_COLOR[status] ?? '#22d3ee';
}
