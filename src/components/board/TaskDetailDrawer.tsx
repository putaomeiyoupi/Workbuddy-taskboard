/**
 * TaskDetailDrawer —— 任务详情抽屉
 *
 * 展示完整执行日志（流式追加）、任务配置、以及状态相关的操作按钮。
 * 运行中的任务日志会自动滚动到底部。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, MessagePlugin, Popconfirm, Textarea } from 'tdesign-react';
import {
  X,
  Play,
  Square,
  RotateCcw,
  Trash2,
  ArrowLeft,
  Clock,
  Puzzle,
  Cpu,
  GitBranch,
  Files,
  AlertTriangle,
  Zap,
  Send,
  Pause,
} from 'lucide-react';
import type { Task, Workspace, ProgressEntry } from '../../types';
import { colorOf, isActive, isAwaitingApproval, isExecuting, labelOf } from './boardConfig';
import { useDrawerAnimation } from './useDrawerAnimation';
import { countdownText, toTs } from '../../utils/timeText';
import { useCountdownClock } from '../../hooks/useCountdownClock';

interface TaskDetailDrawerProps {
  task: Task | null;
  workspaces: Workspace[];
  onClose: () => void;
  onCancel: (id: string) => Promise<unknown>;
  onRetry: (id: string) => Promise<unknown>;
  onMoveToTodo: (id: string) => Promise<unknown>;
  onTriggerNow: (id: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onSubmitDecision: (id: string, answer: string) => Promise<unknown>;
  /** 向执行中（或刚结束）的任务追加指令 */
  onFollowup: (id: string, text: string) => Promise<{ ok: boolean; mode?: string; error?: string }>;
  /** 读取宿主侧完整执行明细（只读） */
  onFetchTranscript: (id: string) => Promise<{ ok: boolean; updates?: unknown[]; error?: string }>;
  onOpenSession?: (sessionId: string) => void;
  /** 暂停 / 恢复定期循环（暂停后仍留在「自动化定时」列，配置不丢） */
  onToggleRepeatPause?: (id: string, paused: boolean) => Promise<unknown>;
  /** 关闭定期循环（repeat_mode 置回 none；任务从「自动化定时」回到待办） */
  onClearRepeat?: (id: string) => Promise<unknown>;
}

/** 格式化时间戳为 HH:mm:ss */
function hms(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fullTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/** 计算耗时 */
function elapsed(start: string | null, end: string | null): string {
  if (!start) return '—';
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const sec = Math.max(0, Math.floor((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

const logEntryClass = (entry: ProgressEntry): string => {
  switch (entry.kind) {
    case 'error':
      return 'log-entry--error';
    case 'tool':
      return 'log-entry--tool';
    case 'tool_result':
      return entry.status === 'error' ? 'log-entry--error' : 'log-entry--ok';
    case 'system':
      return 'log-entry--sys';
    default:
      return '';
  }
};

export const TaskDetailDrawer: React.FC<TaskDetailDrawerProps> = ({
  task,
  workspaces,
  onClose,
  onCancel,
  onRetry,
  onMoveToTodo,
  onTriggerNow,
  onDelete,
  onSubmitDecision,
  onFollowup,
  onFetchTranscript,
  onOpenSession,
  onToggleRepeatPause,
  onClearRepeat,
}) => {
  const [decisionInput, setDecisionInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** 跟进输入框内容 —— 发送失败时会保留，不丢用户输入 */
  const [followupInput, setFollowupInput] = useState('');
  const [followupSending, setFollowupSending] = useState(false);
  /** 宿主原始执行明细（点击才拉取，避免每次开抽屉都打一次接口） */
  const [transcript, setTranscript] = useState<unknown[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const lastTaskIdRef = useRef<string | null>(null);

  /**
   * 关闭动画交给统一 hook：**每次打开/切换任务都会复位**并取消未触发的关闭定时器。
   * 否则「关掉再点同一个任务」会带着滑出动画渲染（弹出来又自动收回去），详见 hook 注释。
   */
  const { closing, requestClose } = useDrawerAnimation(task?.id ?? null, onClose);

  const accent = task ? colorOf(task) : '#22d3ee';
  /** 判数组：`progress_log` 在库里是 JSON 字符串，形态不对时不能让整个抽屉崩掉 */
  const logs = useMemo(
    () => (Array.isArray(task?.progress_log) ? task.progress_log : []),
    [task]
  );
  /** 同上：可选决策项 */
  const decisionOptions = useMemo(
    () => (Array.isArray(task?.decision_options) ? task.decision_options : []),
    [task]
  );

  /**
   * 「下次执行」的秒级节拍（用户要求：抽屉与卡片两处都要倒计时读秒）。
   * ⚠️ 必须与其他 hook 一样在**早退之前**调用 —— `task` 为 null 时传 null
   * （hook 内部不解节拍），否则 hook 数量会随 task 有无而变化，触发 React #310。
   */
  const nextRunTs = task && task.status === 'scheduled' ? toTs(task.scheduled_at) : null;
  const nextRunClock = useCountdownClock(nextRunTs);
  /** 是否循环任务（看板自建） */
  const isRepeating = !!task?.repeat_mode && task.repeat_mode !== 'none';
  const repeatPaused = task?.repeat_paused === 1;

  /**
   * 是否显示「引导当前对话」输入框。
   *
   * ✅ 2026-09-15 已修好并启用：此前后端注入会让 agent **丢失会话上下文**
   *   （agent 答"我这边没有之前的对话上下文"）。根因在**注入消息的形态**：
   *   原先带了 `isSynthetic: true` 且用真实 `session_id`；对齐 SDK 自己的信封
   *   （`{ type:'user', session_id:'', message:{...}, parent_tool_use_id:null }`，见
   *   `transport/process-transport.js` 的 `sendUserMessage`）后**上下文完好**。
   *
   * ⚠️ 使用提示（已写在输入框下方的 hint 里）：追加的指令要等 agent **走到下一轮**才生效；
   *   任务若已临近结束，可能来不及读到（实测：注入会照常送达，但短任务会直接收工）。
   *
   * ⚠️ 只对**看板自己执行的任务**有效（agent 由看板 spawn，句柄在本进程内）。
   *   · WB 的会话做不到（不在我们进程里，其提问绑定在宿主会话运行时上）
   *   · 历史 `workbuddy` 任务不行 —— 那条 host_job_id 通道已下线
   */
  const canFollowup =
    !!onFollowup &&
    !!task &&
    task.executor !== 'workbuddy' &&
    (isExecuting(task) || isAwaitingApproval(task));

  // 切换任务时重置决策输入
  useEffect(() => {
    if (task && task.id !== lastTaskIdRef.current) {
      lastTaskIdRef.current = task.id;
      setDecisionInput('');
      setFollowupInput('');
      setTranscript(null);
    }
  }, [task]);

  // 运行中 / 待决策：日志自动滚到底
  useEffect(() => {
    if (!logRef.current) return;
    const auto = !!task && isExecuting(task);
    if (auto) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs.length, task?.status]);

  const handleClose = requestClose;

  /**
   * 发送跟进。
   * 失败时**保留输入内容**并提示错误 —— 用户敲了一段话不该因为一次网络抖动就丢。
   */
  const handleFollowup = async () => {
    if (!task) return;
    const text = followupInput.trim();
    if (!text || followupSending) return;

    setFollowupSending(true);
    try {
      const r = await onFollowup(task.id, text);
      if (r?.ok) {
        MessagePlugin.success(r.mode ? `已发送：${r.mode}` : '已发送');
        setFollowupInput('');
      } else {
        MessagePlugin.error(r?.error || '跟进失败');
      }
    } finally {
      setFollowupSending(false);
    }
  };

  /** 拉取宿主原始执行明细（点击时才拉，避免每次打开抽屉都打接口） */
  const handleLoadTranscript = async () => {
    if (!task) return;
    if (transcript) {
      setTranscript(null); // 再点一次收起
      return;
    }
    setTranscriptLoading(true);
    try {
      const r = await onFetchTranscript(task.id);
      if (r?.ok) {
        setTranscript(r.updates ?? []);
      } else {
        MessagePlugin.error(r?.error || '读取执行明细失败');
      }
    } finally {
      setTranscriptLoading(false);
    }
  };

  const handleDecision = async () => {
    if (!task) return;
    if (!decisionInput.trim()) {
      MessagePlugin.warning('请填写决策内容');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmitDecision(task.id, decisionInput.trim());
      MessagePlugin.success('决策已提交，任务回到待办队列');
      setDecisionInput('');
    } finally {
      setSubmitting(false);
    }
  };

  if (!task) return null;

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-[1100]"
        style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
        onClick={handleClose}
      />

      <div className={`task-drawer ${closing ? 'task-drawer--out' : 'task-drawer--in'}`}>
        {/* 头部 */}
        <div
          className="flex items-start gap-3 px-4 py-3.5"
          style={{ borderBottom: '1px solid var(--hairline)' }}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="text-[12.5px] font-mono font-semibold px-1.5 py-0.5 rounded"
                style={{
                  color: accent,
                  background: `color-mix(in srgb, ${accent} 14%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
                  letterSpacing: '0.06em',
                }}
              >
                {labelOf(task)}
              </span>
              <span className="text-[12.5px] font-mono" style={{ color: '#475569' }}>
                {task.id.slice(0, 8)}
              </span>
              {isExecuting(task) && (
                <span className="text-[12.5px] font-mono term-cursor" style={{ color: accent }}>
                  EXECUTING
                </span>
              )}
            </div>
            <div className="text-[15.5px] font-medium leading-snug" style={{ color: '#e6edf7' }}>
              {task.title}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="board-toolbar-btn !h-7 !px-2 shrink-0"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {/* 元信息 */}
        <div
          className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-[13.5px]"
          style={{ borderBottom: '1px solid var(--hairline)', background: 'rgba(0,0,0,0.18)' }}
        >
          <MetaRow
            icon={<Puzzle size={11} />}
            label="工作空间"
            value={
              workspaces.find(w => w.id === task.workspace_id)?.name ||
              task.workspace?.name ||
              '未指定'
            }
            mono
          />
          <MetaRow icon={<Cpu size={11} />} label="模型" value={task.model} mono />
          <MetaRow
            icon={<Zap size={11} />}
            label="优先级"
            value={['低', '中', '高'][task.priority] ?? '中'}
          />
          <MetaRow
            icon={<Clock size={11} />}
            label="耗时"
            value={elapsed(task.started_at, task.finished_at)}
            mono
          />
          {task.depends_on.length > 0 && (
            <MetaRow
              icon={<GitBranch size={11} />}
              label="前置依赖"
              value={`${task.depends_on.length} 个任务`}
              mono
            />
          )}
          {task.scopes.length > 0 && (
            <MetaRow
              icon={<Files size={11} />}
              label="修改范围"
              value={
                task.scopes.length <= 3
                  ? task.scopes.join('  ')
                  : `${task.scopes.slice(0, 3).join('  ')} 等 ${task.scopes.length} 项`
              }
              mono
            />
          )}
          {task.scheduled_at && (
            <MetaRow
              icon={<Clock size={11} />}
              label={isRepeating ? '下次执行' : '计划执行'}
              /**
               * ⚠️ 用户要求：这里的「下次执行」必须有**倒计时读秒**
               *   （不足 1 分钟时逐秒跳），只有绝对时间会让人以为卡住了。
               *   节拍见 `useCountdownClock`（<60s → 1 秒，否则 30 秒）。
               */
              value={
                <>
                  <span>{fullTime(task.scheduled_at)}</span>
                  <span
                    className="ml-2 font-mono"
                    style={{ color: repeatPaused ? '#94a3b8' : '#c084fc' }}
                  >
                    还有 {countdownText(toTs(task.scheduled_at), nextRunClock)}
                  </span>
                </>
              }
              tip={
                repeatPaused
                  ? '已暂停：不会触发，恢复时会重算到下一个未来时刻'
                  : `距下次执行 ${countdownText(toTs(task.scheduled_at), nextRunClock)}`
              }
              mono
            />
          )}
          {isRepeating && (
            <MetaRow
              icon={<Clock size={11} />}
              label="循环"
              value={
                <>
                  <span>{task.repeat_desc ?? '循环'}</span>
                  <span className="ml-2 opacity-80">
                    已执行 {task.repeat_count}
                    {task.repeat_limit ? ` / ${task.repeat_limit}` : ''} 次
                  </span>
                  {task.repeat_until && (
                    <span className="ml-2 opacity-70">
                      截止 {new Date(task.repeat_until).toLocaleDateString()}
                    </span>
                  )}
                  {repeatPaused && (
                    <span className="ml-2" style={{ color: '#fbbf24' }}>
                      已暂停
                    </span>
                  )}
                </>
              }
              tip="定期循环（看板自建任务）。每跑完一轮自动排下一轮，各轮明细见「执行历史」"
              mono
            />
          )}
        </div>

        {/* 保留占用提示：任务被有意挂起等待核对（不是正常执行中） */}
        {task.wait_reason && (
          <div className="task-wait-notice">
            <div className="task-wait-title">
              <AlertTriangle size={13} />
              保留占用 · 等待核对
            </div>
            <div className="task-wait-body">{task.wait_reason}</div>
          </div>
        )}

        {/* 待决策面板 */}
        {isAwaitingApproval(task) && (
          <div className="px-4 pt-3.5">
            <div className="decision-panel">
              <div className="decision-panel-title">
                <AlertTriangle size={13} />
                需要你的决策才能继续
              </div>
              {task.decision_prompt && (
                <div
                  className="text-[14.5px] leading-relaxed mb-3 font-mono"
                  style={{ color: '#fcd34d' }}
                >
                  {task.decision_prompt}
                </div>
              )}

              {/* 预设选项 */}
              {decisionOptions.length > 0 && (
                <div className="mb-3">
                  {decisionOptions.map((opt, i) => (
                    <button
                      key={i}
                      className={`decision-option ${
                        decisionInput === opt ? 'decision-option--selected' : ''
                      }`}
                      onClick={() => setDecisionInput(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}

              <Textarea
                value={decisionInput}
                onChange={v => setDecisionInput(String(v))}
                placeholder="也可以直接输入自定义决策，例如：允许修改，但不要动 config 目录"
                autosize={{ minRows: 2, maxRows: 6 }}
              />

              <div className="flex justify-end gap-2 mt-3">
                <Button
                  size="small"
                  theme="warning"
                  onClick={handleDecision}
                  loading={submitting}
                >
                  提交决策并回到待办
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 操作区 */}
        <div className="flex flex-wrap gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--hairline)' }}>
          {isExecuting(task) && (
            <Popconfirm
              content="取消后任务将被标记为失败，可稍后重试。确认取消？"
              onConfirm={async () => {
                await onCancel(task.id);
                MessagePlugin.success('已取消执行');
              }}
            >
              <Button size="small" variant="outline" theme="danger" icon={<Square size={12} />}>
                取消执行
              </Button>
            </Popconfirm>
          )}

          {task.status === 'failed' && (
            <Button
              size="small"
              variant="outline"
              icon={<RotateCcw size={12} />}
              onClick={async () => {
                await onRetry(task.id);
                MessagePlugin.success('已重新排入待办');
              }}
            >
              重试
            </Button>
          )}

          {task.status === 'cancelled' && (
            <Button
              size="small"
              variant="outline"
              icon={<RotateCcw size={12} />}
              onClick={async () => {
                await onRetry(task.id);
                MessagePlugin.success('已重新排入待办');
              }}
            >
              重新入队
            </Button>
          )}

          {task.status === 'scheduled' && (
            <Button
              size="small"
              variant="outline"
              icon={<Play size={12} />}
              onClick={async () => {
                await onTriggerNow(task.id);
                MessagePlugin.success('已立即触发，进入待办队列');
              }}
            >
              立即执行
            </Button>
          )}

          {(isAwaitingApproval(task) || task.status === 'scheduled') && (
            <Button
              size="small"
              variant="outline"
              icon={<ArrowLeft size={12} />}
              onClick={async () => {
                await onMoveToTodo(task.id);
                MessagePlugin.success('已移回待办');
              }}
            >
              移回待办
            </Button>
          )}

          {task.session_id && onOpenSession && (
            <Button
              size="small"
              variant="outline"
              onClick={() => onOpenSession(task.session_id!)}
            >
              查看完整对话
            </Button>
          )}

          {/**
           * 循环任务的控制：暂停/恢复 + 关闭循环。
           * ⚠️ 暂停只是「不再触发」，任务仍留在「自动化定时」列（配置不丢）；
           *    恢复时后端会**重算排期**，不会把暂停期间积压的轮次一次性补跑。
           */}
          {isRepeating && onToggleRepeatPause && (
            <Button
              size="small"
              variant="outline"
              icon={repeatPaused ? <Play size={12} /> : <Pause size={12} />}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await onToggleRepeatPause(task.id, !repeatPaused);
                  MessagePlugin.success(repeatPaused ? '已恢复循环' : '已暂停循环');
                } finally {
                  setSubmitting(false);
                }
              }}
              disabled={submitting || task.status === 'in_progress'}
              title={
                task.status === 'in_progress'
                  ? '任务正在执行中，等这一轮结束再改'
                  : repeatPaused
                    ? '恢复后会重算到下一个未来时刻（不补跑暂停期间的轮次）'
                    : '暂停后不再触发，但循环配置保留'
              }
            >
              {repeatPaused ? '恢复循环' : '暂停循环'}
            </Button>
          )}
          {isRepeating && onClearRepeat && (
            <Popconfirm
              content="关闭循环后，本任务只会跑一次；已配置的循环规则会被清除。确认？"
              onConfirm={async () => {
                setSubmitting(true);
                try {
                  await onClearRepeat(task.id);
                  MessagePlugin.success('已关闭循环');
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              <Button size="small" variant="outline" disabled={submitting || task.status === 'in_progress'}>
                关闭循环
              </Button>
            </Popconfirm>
          )}

          <Popconfirm
            content="删除后不可恢复（含执行记录）。确认删除？"
            onConfirm={async () => {
              await onDelete(task.id);
              handleClose();
              MessagePlugin.success('任务已删除');
            }}
          >
            <Button
              size="small"
              variant="outline"
              theme="danger"
              icon={<Trash2 size={12} />}
              className="ml-auto"
            >
              删除
            </Button>
          </Popconfirm>
        </div>

        {/* 任务指令 */}
        <div
          className="px-4 py-3 max-h-[22%] overflow-y-auto"
          style={{ borderBottom: '1px solid var(--hairline)' }}
        >
          <div
            className="text-[12.5px] font-mono mb-1.5 tracking-wider"
            style={{ color: '#475569' }}
          >
            INSTRUCTION
          </div>
          <pre
            className="text-[14px] leading-relaxed whitespace-pre-wrap font-mono"
            style={{ color: '#a8b8d0' }}
          >
            {task.prompt}
          </pre>
          {task.decision_answer && (
            <>
              <div
                className="text-[12.5px] font-mono mt-3 mb-1.5 tracking-wider"
                style={{ color: '#fbbf24' }}
              >
                DECISION
              </div>
              <pre
                className="text-[14px] leading-relaxed whitespace-pre-wrap font-mono"
                style={{ color: '#fcd34d' }}
              >
                {task.decision_answer}
              </pre>
            </>
          )}
        </div>

        {/* 执行日志 */}
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{ borderBottom: '1px solid var(--hairline)' }}
        >
          <span className="text-[12.5px] font-mono tracking-wider" style={{ color: '#475569' }}>
            EXECUTION LOG · {logs.length}
          </span>
          <div className="flex items-center gap-3">
            {task.host_job_id && (
              <button
                type="button"
                onClick={() => void handleLoadTranscript()}
                disabled={transcriptLoading}
                className="text-[12.5px] font-mono underline-offset-2 hover:underline"
                style={{ color: transcript ? accent : '#64748b' }}
                title="读取 WorkBuddy 侧的完整执行原文（只读，最多最近 1000 行）"
              >
                {transcriptLoading ? '读取中…' : transcript ? '收起宿主原文' : '宿主原文'}
              </button>
            )}
            {isExecuting(task) && (
              <span className="text-[12.5px] font-mono" style={{ color: accent }}>
                ● 实时
              </span>
            )}
          </div>
        </div>

        {/* 宿主原始执行明细（按需展开） */}
        {transcript && (
          <div className="task-transcript">
            {transcript.length === 0 ? (
              <span className="opacity-50">（宿主未返回任何记录）</span>
            ) : (
              <pre>{JSON.stringify(transcript, null, 2)}</pre>
            )}
          </div>
        )}

        <div ref={logRef} className="task-drawer-log">
          {logs.length === 0 ? (
            <div className="opacity-40 font-mono text-[13.5px]">
              // 尚无执行记录
            </div>
          ) : (
            logs.map((entry, i) => (
              <div key={i} className={`log-entry ${logEntryClass(entry)}`}>
                <span className="log-entry-time">{hms(entry.at)}</span>
                <span className="log-entry-body">
                  {entry.toolName && entry.kind === 'tool' && (
                    <span style={{ color: '#38bdf8' }}>[{entry.toolName}] </span>
                  )}
                  {entry.text}
                </span>
              </div>
            ))
          )}
        </div>

        {/* 跟进输入框：向执行中（或刚结束）的宿主任务追加指令 */}
        {canFollowup && (
          <div className="task-followup">
            <textarea
              value={followupInput}
              onChange={e => setFollowupInput(e.target.value)}
              onKeyDown={e => {
                // Enter 发送，Shift+Enter 换行（与参照项目一致）
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleFollowup();
                }
              }}
              placeholder={
                isExecuting(task)
                  ? '追加一句指令，会补进当前执行的回合…（Enter 发送，Shift+Enter 换行）'
                  : '用同一个会话继续交代一件事…（Enter 发送，Shift+Enter 换行）'
              }
              rows={2}
              disabled={followupSending}
            />
            <div className="task-followup-footer">
              <span className="task-followup-hint">
                {followupSending
                  ? '正在发送…'
                  : 'Enter 发送 · Shift+Enter 换行 · 追加的指令在 agent 下一轮生效（临近结束可能来不及读到）'}
              </span>
              <button
                type="button"
                className="task-followup-send"
                onClick={() => void handleFollowup()}
                disabled={followupSending || !followupInput.trim()}
                title={followupSending ? '正在发送…' : '发送跟进消息'}
                aria-label="发送跟进消息"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        )}

        {/* 底部结果 */}
        {task.result && !isExecuting(task) && (
          <div className="task-drawer-footer">
            <div
              className="text-[12.5px] font-mono mb-1.5 tracking-wider"
              style={{ color: '#475569' }}
            >
              RESULT
            </div>
            <div
              className="text-[14px] leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap"
              style={{ color: '#86efac' }}
            >
              {task.result}
            </div>
          </div>
        )}
      </div>
    </>
  );
};

const MetaRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  /** 值可以是节点（如「绝对时间 + 实时倒计时」两段） */
  value: React.ReactNode;
  /** 悬停提示；不传则在 value 是字符串时用 value 兜底 */
  tip?: string;
  mono?: boolean;
}> = ({ icon, label, value, tip, mono }) => (
  <div className="flex items-center gap-1.5 min-w-0">
    <span style={{ color: '#475569' }}>{icon}</span>
    <span style={{ color: '#64748b' }}>{label}</span>
    <span
      className={`truncate ${mono ? 'font-mono' : ''}`}
      style={{ color: '#cbd5e1' }}
      title={tip ?? (typeof value === 'string' ? value : undefined)}
    >
      {value}
    </span>
  </div>
);

export default TaskDetailDrawer;
