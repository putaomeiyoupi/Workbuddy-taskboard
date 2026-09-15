/**
 * TaskCard —— 看板任务卡片
 *
 * 视觉语言：
 *  - 左侧霓虹状态条按状态着色
 *  - running  状态边框呼吸
 *  - pending_decision 状态边框脉冲 + 警示点闪烁
 *  - 卡片内联展示最近几条执行日志（终端风格，运行中带光标）
 */

import React, { memo } from 'react';
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Puzzle,
  GitBranch,
  Play,
  Wrench,
  Repeat,
  PauseCircle,
} from 'lucide-react';
import type { Task, TaskStatus } from '../../types';
import { colorOf, isActive, isAwaitingApproval, labelOf } from './boardConfig';
import { untilTime, toTs } from '../../utils/timeText';
import { useCountdownClock } from '../../hooks/useCountdownClock';

interface TaskCardProps {
  task: Task;
  selected?: boolean;
  /** 刚移动到本列（用于入场高亮） */
  landed?: boolean;
  /** 首次出现（入场动画） */
  enter?: boolean;
  /** 依赖任务标题（用于展示阻塞来源） */
  blockedBy?: string[];
  onSelect: (task: Task) => void;
  onDragStart?: (task: Task) => void;
  onDragEnd?: () => void;
  draggable?: boolean;
}

/** 格式化相对时间 */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const future = diff < 0;

  const min = Math.floor(abs / 60000);
  const hour = Math.floor(min / 60);
  const day = Math.floor(hour / 24);

  let text: string;
  if (min < 1) text = '刚刚';
  else if (min < 60) text = `${min}分钟`;
  else if (hour < 24) text = `${hour}小时`;
  else text = `${day}天`;

  return future ? `in ${text}` : `${text}前`;
}

/** 格式化绝对时间（用于定时任务） */
function formatAbsolute(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 模型名简写 */
function shortModel(model: string): string {
  return model
    .replace(/^(Claude|GPT|Gemini|Kimi|DeepSeek|Qwen|GLM)[-\s]*/i, '')
    .replace(/-/g, ' ')
    .slice(0, 22);
}

const TaskCardInner: React.FC<TaskCardProps> = ({
  task,
  selected,
  landed,
  enter,
  blockedBy,
  onSelect,
  onDragStart,
  onDragEnd,
  draggable = true,
}) => {
  const accent = colorOf(task);
  const isRunning = isActive(task);
  const isDecision = isAwaitingApproval(task);
  const isScheduled = task.status === 'scheduled';
  const isBlocked = !!blockedBy && blockedBy.length > 0;
  /** 循环任务（看板自建）：repeat_mode 非 none 且有 desc */
  const isRepeating = !!task.repeat_mode && task.repeat_mode !== 'none';
  const repeatPaused = task.repeat_paused === 1;
  /**
   * 「下次执行」的秒级节拍。
   * ⚠️ 用户要求：距触发不足 1 分钟时必须**逐秒跳动**，否则看着像卡住。
   *    节拍按距离自动分档（<60s → 1 秒，否则 30 秒），见 useCountdownClock。
   */
  const nextRunClock = useCountdownClock(isScheduled ? toTs(task.scheduled_at) : null);

  /**
   * 最近日志（最多 3 条）。
   *
   * ⚠️ 必须显式判数组：`progress_log` 在库里是 JSON **字符串**，
   * 曾因为一条 SSE 事件漏了序列化，字符串的 `.slice(-3)` 返回 string，
   * 随后 `.map` 抛错 → 整块看板被 ErrorBoundary 兜成「界面渲染出错」。
   * 这里再兜一层，保证单个字段形态异常不会让整个界面不可用。
   */
  const recentLogs = Array.isArray(task.progress_log) ? task.progress_log.slice(-3) : [];

  const classes = [
    'task-card',
    isRunning ? 'task-card--running' : '',
    isDecision ? 'task-card--decision' : '',
    landed ? 'task-card--landed' : '',
    enter ? 'task-card--enter' : '',
    selected ? 'ring-1' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      data-task-id={task.id}
      style={
        {
          '--card-accent': accent,
        } as React.CSSProperties
      }
      onClick={() => onSelect(task)}
      draggable={draggable}
      onDragStart={e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        onDragStart?.(task);
      }}
      onDragEnd={() => onDragEnd?.()}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(task);
        }
      }}
    >
      {/* 标题行 */}
      <div className="flex items-start gap-2">
        {/* 优先级条 */}
        <div
          className={`task-priority-bar task-priority-bar--p${task.priority} shrink-0 mt-0.5`}
          title={`优先级：${['低', '中', '高'][task.priority] ?? '中'}`}
        >
          <span />
          <span />
          <span />
        </div>

        <div className="task-card-title flex-1">{task.title}</div>

        {isDecision && (
          <AlertTriangle
            size={14}
            className="task-card-alert-dot shrink-0 mt-0.5"
            style={{ color: accent }}
          />
        )}
        {task.status === 'done' && (
          <CheckCircle2 size={14} className="shrink-0 mt-0.5" style={{ color: '#34d399' }} />
        )}
        {task.status === 'failed' && (
          <XCircle size={14} className="shrink-0 mt-0.5" style={{ color: '#f87171' }} />
        )}
      </div>

      {/* 元信息行 */}
      <div className="task-card-meta">
        {/* 工作空间 */}
        {task.workspace && (
          <span
            className="task-chip task-chip--accent"
            style={{ '--chip-color': task.workspace.color || '#22d3ee' } as React.CSSProperties}
            title={task.workspace.path}
          >
            <Puzzle size={9} />
            {task.workspace.name}
          </span>
        )}

        {/* 模型 */}
        <span className="task-chip" title={task.model}>
          {shortModel(task.model)}
        </span>

        {/* 下次执行：倒计时（<1 分钟逐秒跳动），绝对时间放 title */}
        {isScheduled && task.scheduled_at && (
          <span
            className="task-chip task-chip--accent"
            style={{ '--chip-color': '#f472b6' } as React.CSSProperties}
            title={`计划执行：${new Date(task.scheduled_at).toLocaleString()}`}
          >
            <Clock size={9} />
            {untilTime(toTs(task.scheduled_at), nextRunClock)}
          </span>
        )}

        {/* 循环规则（看板自建任务；宿主定时任务仍只读展示在宿主卡片上） */}
        {isRepeating && (
          <span
            className="task-chip task-chip--accent"
            style={{ '--chip-color': repeatPaused ? '#94a3b8' : '#a78bfa' } as React.CSSProperties}
            title={
              `${task.repeat_desc ?? '循环'}｜已执行 ${task.repeat_count} 次` +
              (task.repeat_limit ? ` / 上限 ${task.repeat_limit} 次` : '') +
              (task.repeat_until ? `｜截止 ${new Date(task.repeat_until).toLocaleString()}` : '') +
              (repeatPaused ? '｜已暂停' : '')
            }
          >
            {repeatPaused ? <PauseCircle size={9} /> : <Repeat size={9} />}
            {task.repeat_desc ?? '循环'}
            {task.repeat_limit ? ` ${task.repeat_count}/${task.repeat_limit}` : ` ×${task.repeat_count}`}
          </span>
        )}

        {/* 依赖 */}
        {task.depends_on.length > 0 && (
          <span
            className="task-chip"
            title={`依赖 ${task.depends_on.length} 个前置任务`}
          >
            <GitBranch size={9} />
            {task.depends_on.length}
          </span>
        )}

        {/* 重试次数 */}
        {task.retry_count > 0 && (
          <span className="task-chip" title={`已重试 ${task.retry_count} 次`}>
            重试×{task.retry_count}
          </span>
        )}

        {/* 时间 */}
        <span className="ml-auto text-[12.5px] opacity-70">
          {relativeTime(task.started_at || task.updated_at)}
        </span>
      </div>

      {/* 阻塞提示 */}
      {isBlocked && task.status === 'todo' && (
        <div
          className="mt-2 flex items-center gap-1.5 text-[13px]"
          style={{ color: '#94a3b8' }}
          title={`等待：${blockedBy!.join('、')}`}
        >
          <GitBranch size={10} />
          <span className="truncate">等待前置：{blockedBy!.join('、')}</span>
        </div>
      )}

      {/* 决策提示 */}
      {isDecision && task.decision_prompt && (
        <div
          className="mt-2 rounded px-2 py-1.5 text-[13.5px] leading-snug"
          style={{
            background: 'rgba(251, 191, 36, 0.10)',
            border: '1px solid rgba(251, 191, 36, 0.28)',
            color: '#fcd34d',
          }}
        >
          <span className="font-medium">待确认：</span>
          {task.decision_prompt}
        </div>
      )}

      {/* 执行日志（运行中 / 待决策时展示） */}
      {(isRunning || isDecision) && recentLogs.length > 0 && (
        <div className={`task-card-log ${isRunning ? 'term-cursor' : ''}`}>
          {recentLogs.map((entry, i) => {
            const cls =
              entry.kind === 'error'
                ? 'task-card-log-line--error'
                : entry.kind === 'tool'
                  ? 'task-card-log-line--tool'
                  : entry.kind === 'tool_result'
                    ? entry.status === 'error'
                      ? 'task-card-log-line--error'
                      : 'task-card-log-line--ok'
                    : entry.kind === 'system'
                      ? 'task-card-log-line--sys'
                      : '';
            const Icon =
              entry.kind === 'tool' ? Wrench : entry.kind === 'system' ? Play : null;
            return (
              <div key={i} className={`task-card-log-line ${cls}`}>
                {Icon && <Icon size={9} className="shrink-0 mt-1" />}
                <span className="flex-1">{entry.text}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* 失败原因 */}
      {task.status === 'failed' && task.error && (
        <div
          className="mt-2 rounded px-2 py-1.5 text-[13px] leading-snug"
          style={{
            background: 'rgba(248, 113, 113, 0.09)',
            border: '1px solid rgba(248, 113, 113, 0.25)',
            color: '#fca5a5',
          }}
        >
          <span className="truncate block">{task.error.slice(0, 140)}</span>
        </div>
      )}
    </div>
  );
};

/**
 * 自定义 memo 比较：按「卡片**真正渲染用到的**字段」判等
 * ============================================================================
 * 🔴 2026-09-16 加（审计 H4）。原先写的是 `memo(TaskCardInner)`（**默认浅比较**），
 *    而它有两个 prop **每次渲染引用都是新的**：
 *      ① `onSelect`  —— 父组件里的 inline 箭头（已顺手用 `useCallback` 稳定）
 *      ② `blockedBy` —— 父组件里 `.map().filter().map()` 的产物：
 *                       **内容经常没变，但引用必变**
 *    ⇒ 默认浅比较恒不相等 ⇒ **memo 恒定失效**，任一条 SSE 任务事件都会让
 *      **全部**卡片重渲染。这与项目自己的纪律相悖 ——
 *      「高频列表项必须 `memo` + 按自己真正用到的字段比较（对象每帧都是新的，
 *        默认浅比较无效）」，`HostCard` 早已这么做。
 *
 * ⚠️ `task` 这里仍用**引用比较**，是有依据的（不是偷懒）：
 *    `useTasks` 的 `upsertTask` 走 `next[idx] = { ...next[idx], ...incoming }`，
 *    **只替换被更新的那一条**，其余任务保持原引用 ⇒ 引用相等就意味着该卡无需重渲染。
 *    （建连时的 `snapshot` 会整批换新对象，但那是每次会话一次性的，可接受。）
 */
function areSameProps(a: TaskCardProps, b: TaskCardProps): boolean {
  return (
    a.task === b.task &&
    a.selected === b.selected &&
    a.landed === b.landed &&
    a.enter === b.enter &&
    a.draggable === b.draggable &&
    a.onSelect === b.onSelect &&
    a.onDragStart === b.onDragStart &&
    a.onDragEnd === b.onDragEnd &&
    sameStringArray(a.blockedBy, b.blockedBy)
  );
}

/** 字符串数组的**值**比较 —— `blockedBy` 每帧都是新数组，只能比内容 */
function sameStringArray(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const TaskCard = memo(TaskCardInner, areSameProps);
export default TaskCard;
