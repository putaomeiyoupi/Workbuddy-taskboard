/**
 * HostDrawer —— WorkBuddy 宿主会话 / 自动化的上下文抽屉（**只读**）
 * ============================================================
 * 用户诉求（2026-09-14）：「点击看板上的某个任务时，应该弹出上下文信息并进行对应操作。」
 *
 * 现在只做**看**，不做**改**：
 *  1. 会话卡在 `pending`（桌面端「待确认」）→ 展示**它在问什么、有哪些选项**
 *  2. 会话在 `working` → 展示**实时活动流**（具体在执行什么）
 *  3. 会话已结束 → 展示最近上下文（RECENT CONTEXT）
 *  4. 自动化定时任务 → 展示完整信息 + 一键复制（要改请去 WorkBuddy）
 *
 * ⚠️ 2026-09-15：原先这里还能「回复 / 继续 / 停止 / 重启实例」，走 CodeBuddy CLI 的
 * `--serve` REST + ACP 通道。该通道已整体下线 —— 理由是看板已嵌入宿主界面、
 * 宿主原生 UI 就在旁边，在这里复刻一套对话操作属重复造轮子（见 `内部归档`）。
 * ⇒ 要作答 / 派发，请直接用 WorkBuddy。
 *
 * ⚠️ 宿主库始终**只读**。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, MessagePlugin } from 'tdesign-react';
import {
  X,
  Cpu,
  FolderOpen,
  Clock,
  Hash,
  AlertTriangle,
  Timer,
  CircleDot,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react';
import type { HostSession, HostAutomation, HostAutomationRun, Model } from '../../types';
import { formatRrule } from '../../utils/rrule';
import { countdownText } from '../../utils/timeText';
import { useCountdownClock } from '../../hooks/useCountdownClock';
import { AWAIT_ACCENT } from './boardConfig';

/** 与服务端 hostTranscript.ts 对应的最小类型（只读展示用） */
interface QuestionOption {
  label: string;
  description?: string;
}
interface PendingQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}
interface TailMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}
/** 运行中会话的实时活动（与服务端 hostTranscript.ActivityEntry 对应） */
interface ActivityEntry {
  kind: 'text' | 'tool' | 'tool_result';
  text: string;
  at?: number;
  role?: 'user' | 'assistant' | 'system';
  isError?: boolean;
}

/** 运行中会话的活动流轮询间隔（宿主记录是增量写的，2.5s 足够跟手） */
const ACTIVITY_POLL_MS = 2500;
import { useDrawerAnimation } from './useDrawerAnimation';

export interface HostTarget {
  /** 宿主会话（来自宿主库只读快照） */
  session?: HostSession | null;
  /**
   * 宿主的自动化定时任务（点击「自动化定时」列的卡片）。
   *
   * ⚠️ 只读：自动化由 WorkBuddy 桌面端管理，官方 HTTP API **没有更新端点**
   * （只有 GET/POST/DELETE，且那套是按 sessionId 分的另一份集合，
   * 与桌面端 automations 表不是同一份数据）。要改请去 WorkBuddy，这里给足信息 + 可复制。
   */
  automation?: HostAutomation | null;
}

interface HostDrawerProps {
  target: HostTarget | null;
  /** 自动化卡片：附带它的最近一次运行（展示用） */
  automationLatestRun?: HostAutomationRun | null;
  /**
   * 打开该宿主会话的**完整记录**（整页只读，路由 `/host-session/:id`）。
   *
   * ⚠️ 传的必须是**宿主会话 id**（`HostSession.id`，来自宿主库）。
   *    它与「看板任务的会话 id」是两套完全不同的命名空间 ——
   *    后者属于看板自己的 `sessions` 表，应走 `/chat/:id`。详见 `App.tsx` 里的对照表。
   */
  onOpenFullSession?: (sessionId: string) => void;
  onClose: () => void;
  /**
   * ⚠️ 2026-09-15：原先这里还有 7 个**写侧** props（onReply / onRespawn / onStop /
   * onResume / onContinue / onLoadTranscript / onRefresh）与 opLogs 流水。
   * CLI 派发通道已下线（见 `内部归档`）⇒ 全部移除，本抽屉现在**只读**。
   */
}

function hms(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fullTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function tailPath(p: string | undefined): string {
  if (!p) return '—';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

/** 状态 → 展示文案与配色（与卡片保持一致） */
function stateView(target: HostTarget): {
  label: string;
  color: string;
  icon: React.ReactNode;
} {
  const { session, automation } = target;
  if (automation) {
    const paused = automation.status !== 'ACTIVE';
    return {
      label: paused ? `自动化 · ${automation.status}` : '自动化 · 已启用',
      color: paused ? '#94a3b8' : '#f472b6',
      icon: <Timer size={13} />,
    };
  }
  // ⚠️ 2026-09-15：原先这里还有一整个 `if (job)` 分支（实例状态 → 展示文案），
  // 随 CLI 派发通道下线一并移除（见 内部归档）。状态只看宿主会话。
  if (session) {
    if (session.status === 'working') {
      return { label: '宿主执行中', color: '#a78bfa', icon: <Loader2 size={13} className="host-card__spin" /> };
    }
    // 宿主 pending = WorkBuddy 里正在等你回答（桌面端显示「待确认」）
    if (session.status === 'pending') {
      return { label: '待确认 · 等你回应', color: AWAIT_ACCENT, icon: <AlertTriangle size={13} /> };
    }
    if (session.status === 'error') {
      return { label: '出错结束', color: '#f87171', icon: <XCircle size={13} /> };
    }
    return { label: '已结束（未归档）', color: '#34d399', icon: <CheckCircle2 size={13} /> };
  }
  return { label: '未知', color: '#94a3b8', icon: <AlertTriangle size={13} /> };
}

// ⚠️ 2026-09-15：原先这里还有 `OP_KIND_LABEL`（宿主操作流水的中文标签）与
// `REPLY_PRESETS`（一键确认回复模板）—— 都属写侧，随 CLI 派发通道下线一并移除。

export const HostDrawer: React.FC<HostDrawerProps> = ({
  target,
  automationLatestRun,
  onOpenFullSession,
  onClose,
}) => {
  // ⚠️ 2026-09-15：原先这里还有一批**写侧 state**（reply / resumeText / busy /
  // transcript / transcriptLoading / resumedJob）。CLI 派发通道已下线
  // （见 内部归档）⇒ 本抽屉现在**只读**，这些状态全部移除。
  const lastKeyRef = useRef<string | null>(null);
  /** 宿主侧的待选择提问（AskUserQuestion）与最近对话 */
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [tailMessages, setTailMessages] = useState<TailMessage[]>([]);
  /** 运行中会话的实时活动流（只读，轮询宿主记录） */
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  /** 活动流最后更新时间（宿主记录文件的 mtime） */
  const [activityAt, setActivityAt] = useState<number | null>(null);
  /** 活动流容器（用于自动滚到底） */
  const activityRef = useRef<HTMLDivElement | null>(null);

  const key = useMemo(() => {
    if (!target) return null;
    return `${target.session?.id ?? ''}|${target.automation?.id ?? ''}`;
  }, [target]);

  // ⚠️ 2026-09-15：原先这里还有 `lastOp`（按目标会话/实例查「最近一次宿主操作」，
  // 用于事后确认"到底提交没提交"）。CLI 派发通道已下线 ⇒ 不再有任何写操作，
  // opLogs 也没有写入方，一并移除（见 内部归档）。

  /**
   * ⚠️ 关闭动画 hook **必须放在下面的 `if (!target) return null` 之前**。
   * 放在早退之后会变成"条件调用 hook"：抽屉关闭时 hook 不执行、打开时才执行，
   * React 会直接抛 **#310（Rendered more hooks than during the previous render）**，
   * 整块看板被 ErrorBoundary 兜成"界面渲染出错"（本轮实测踩到）。
   */
  const { closing, requestClose } = useDrawerAnimation(key, onClose);

  // 切换目标时重置临时状态（否则会把上一个会话的选项/对话带过来）
  useEffect(() => {
    if (key && key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      // 提问与最近上下文是"跟着目标走"的，切换目标必须清掉（否则会把上一个会话的带过来）
      setPendingQuestions([]);
      setTailMessages([]);
    }
  }, [key]);

  /**
   * 读取该会话的「待选择提问 + 最近对话」（只读，来自宿主的 projects/<slug>/<sid>.jsonl）。
   *
   * 为什么必须读它：会话卡在 pending 时，宿主 sessions 表只有元数据 ——
   * 不读对话就不知道它在问什么、有哪些选项，抽屉里空有"继续"按钮，用户无从下手。
   * 只在「明明在等人」的情况下拉（pending 会话 / 卡住的实例），避免无谓 IO。
   */
  // ⚠️ 这两个值必须在这里（早退之前）算好并声明 —— 上面的 useEffect 依赖它们，
  //    而 hook 也绝不能出现在 `if (!target) return null` 之后（会触发 React #310）。
  const transcriptSessionId = target?.session?.id ?? '';
  /** 运行中（宿主会话 working）→ 需要"实时"视图，要轮询 */
  const isLive = target?.session?.status === 'working';
  const shouldLoadTranscript =
    !!transcriptSessionId &&
    (target?.session?.status === 'pending' || isLive);

  /**
   * 定时任务的「下次执行」倒计时节拍（用户要求：抽屉与卡片都要读秒）。
   * ⚠️ 必须与上面两个值一样在**早退之前**声明 —— 否则 hook 会在 `if (!target) return null`
   *    之后被调用，触发 React #310（hook 数量变化）。
   */
  const automationNextRunAt = target?.automation?.next_run_at ?? null;
  const countdownNow = useCountdownClock(automationNextRunAt);

  useEffect(() => {
    if (!shouldLoadTranscript || !transcriptSessionId) {
      setPendingQuestions([]);
      setTailMessages([]);
      setActivity([]);
      setActivityAt(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/host/sessions/${encodeURIComponent(transcriptSessionId)}/transcript?recent=40`
        );
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        setPendingQuestions(Array.isArray(data?.pending?.questions) ? data.pending.questions : []);
        setTailMessages(Array.isArray(data?.tail) ? data.tail : []);
        setActivity(Array.isArray(data?.recent) ? data.recent : []);
        setActivityAt(typeof data?.updatedAt === 'number' ? data.updatedAt : null);
      } catch {
        /* 读不到就不显示，不影响其它操作 */
      }
    };
    void load();
    // 运行中才轮询：其它情况一次就够（宿主记录只在有活动时才变）
    if (!isLive) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(load, ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [shouldLoadTranscript, transcriptSessionId, isLive]);

  // 活动流自动滚到底（只在"运行中"滚，看历史时不打扰）
  useEffect(() => {
    if (!isLive) return;
    const el = activityRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity.length, isLive]);

  if (!target) return null;
  const { session, automation } = target;
  const view = stateView(target);
  const sessionId = session?.id || '';
  const cwd = session?.cwd;
  // ⚠️ 2026-09-15：原先这里还有 job / awaiting / jobActive / jobTerminal / canResume
  // （「继续这个对话」的前置判定）。CLI 派发通道已下线（见 内部归档）
  // ⇒ 本抽屉只读，这些判定与依赖它们的 handler / UI 一并移除。

  const handleClose = requestClose;

  /** 复制到剪贴板 */
  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      MessagePlugin.success(`已复制${what}`);
    } catch {
      MessagePlugin.warning('复制失败，请手动选中复制');
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[1100]"
        /**
         * ⚠️ 2026-09-16：**去掉 `backdropFilter: 'blur(2px)'`**。
         *   全屏毛玻璃在宿主里是「每帧对整个视口重算高斯模糊」——宿主实测
         *   （Chromium 138 / Electron 37，视口 2296×1362 @DPR1.5）打开抽屉时
         *   p50 = 300ms（3.2fps），去掉后 16.7ms。
         *   失去模糊后背景会显得"太清晰"、抢聚焦 ⇒ 用**不透明度**补偿（0.55 → 0.68）。
         */
        style={{ background: 'rgba(0,0,0,0.68)' }}
        onClick={handleClose}
      />

      <div className={`task-drawer ${closing ? 'task-drawer--out' : 'task-drawer--in'}`}>
        {/* 头部 */}
        <div
          className="flex items-start gap-3 px-4 py-3.5"
          style={{ borderBottom: '1px solid var(--hairline)' }}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span
                className="text-[12.5px] font-mono font-semibold px-1.5 py-0.5 rounded flex items-center gap-1"
                style={{
                  color: view.color,
                  background: `color-mix(in srgb, ${view.color} 14%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${view.color} 32%, transparent)`,
                  letterSpacing: '0.06em',
                }}
              >
                {view.icon}
                {view.label}
              </span>
              <span className="text-[12.5px] font-mono" style={{ color: '#475569' }}>
                {automation ? `AUTOMATION ${String(automation.id).slice(0, 8)}` : 'HOST SESSION'}
              </span>
            </div>
            <div className="text-[15.5px] font-medium leading-snug" style={{ color: '#e6edf7' }}>
              {automation?.name || session?.title || '(未命名)'}
            </div>
          </div>
          <button onClick={handleClose} className="board-toolbar-btn !h-7 !px-2 shrink-0" aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        {/* 头部以下整体可滚（头部固定）—— 用户要求：信息多了要能上下滚，别被截断 */}
        <div className="task-drawer-body">
        {/* ⚠️ 2026-09-15：「上次提交的结果」条（宿主写操作流水 lastOp）随 CLI 派发通道
            下线一并移除 —— 本抽屉已无写操作，也没有 opLogs 的写入方。
            详见 内部归档 */}

        {/* 宿主会话：查看**完整记录**（整页只读，路由 `/host-session/:id`）。
            抽屉里只展示「待选择提问 + 最近对话 + 活动流」，要看全部对话与工具调用就点这里。
            ⚠️ 这里传的是**宿主会话 id**；看板任务的会话 id 是另一套（走 `/chat/:id`），别混。 */}
        {session && !automation && onOpenFullSession && (
          <div
            className="flex flex-wrap items-center gap-2 px-4 py-3"
            style={{ borderBottom: '1px solid var(--hairline)' }}
          >
            <Button
              size="small"
              variant="outline"
              onClick={() => onOpenFullSession(session.id)}
            >
              查看完整会话
            </Button>
            <span className="text-[12.5px]" style={{ color: '#64748b' }}>
              整页只读视图（全部对话与工具调用）
            </span>
          </div>
        )}
        {/* ============ 自动化定时任务：完整信息 + 可做的动作 ============
            自动化由 WorkBuddy 桌面端管理，官方 HTTP API 没有更新端点，
            宿主库也保持只读 —— 所以这里把信息给全，并明确说明去哪里改。 */}
        {automation && (
          <>
            <div
              className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-[13.5px]"
              style={{ borderBottom: '1px solid var(--hairline)', background: 'rgba(0,0,0,0.18)' }}
            >
              <MetaRow
                icon={<Timer size={11} />}
                label="执行计划"
                value={formatRrule(automation.rrule || automation.scheduled_at)}
              />
              <MetaRow
                icon={<Clock size={11} />}
                label="下次执行"
                /**
                 * ⚠️ 用户要求：这里必须**有倒计时读秒**（不足 1 分钟时逐秒跳）。
                 *   所以是「绝对时间 + 倒计时」两行，而不是只有绝对时间。
                 *   节拍见上方 `useCountdownClock`（<60s 走 1 秒，否则 30 秒）。
                 */
                value={
                  automation.next_run_at ? (
                    <>
                      {/* 绝对时间与倒计时各自不许内部折行 —— 宽度不够时倒计时**整段**换到第二行，
                          而不是被拆成「还有 12h」/「41m」两截（那样反而更难读）。 */}
                      <span className="whitespace-nowrap">{fullTime(automation.next_run_at)}</span>
                      <span
                        className="ml-2 font-mono whitespace-nowrap"
                        style={{ color: '#c084fc' }}
                        title="距下次执行的实时倒计时"
                      >
                        还有 {countdownText(automation.next_run_at, countdownNow)}
                      </span>
                    </>
                  ) : (
                    '未排期'
                  )
                }
                tip={
                  automation.next_run_at
                    ? `下次执行：${fullTime(automation.next_run_at)}`
                    : '未排期'
                }
                mono
              />
              <MetaRow
                icon={<Clock size={11} />}
                label="上次执行"
                /**
                 * ⚠️ 兜底链（踩过的坑）：宿主 `automations.last_run_at` 本机**恒为 null**，
                 * 只读它会让这里显示"从未执行"，而同屏的「最近一次运行」却有时间和结果 —— 自相矛盾。
                 * 后端已优先取 `automation_runtime_state.last_run_at`；万一仍为空，
                 * 再用运行记录的 `created_at` 兜底（同样能证明"执行过"）。
                 */
                value={
                  automation.last_run_at
                    ? fullTime(automation.last_run_at)
                    : automationLatestRun?.created_at
                      ? `${fullTime(automationLatestRun.created_at)}（据运行记录）`
                      : '从未执行'
                }
                mono
              />
              <MetaRow icon={<Cpu size={11} />} label="模型" value={automation.model_id || '默认'} mono />
              {/* 「工作目录」「调度规则」是长值，**独占整行** —— 放在两列网格里时
                  单列扣掉 icon + label 只剩约 180px（≈22 个等宽字符），
                  `WorkBuddy/automation-2026-...`、`FREQ=DAILY;BYHOUR=12;B...`
                  这类值必然被截断（2026-09-15 用户反馈）。整行约 510px，配合折行可完整显示。 */}
              <div className="col-span-2">
                <MetaRow
                  icon={<FolderOpen size={11} />}
                  label="工作目录"
                  value={automation.cwds.length ? tailPath(automation.cwds[0]) : '—'}
                  mono
                  title={automation.cwds.join('\n')}
                />
              </div>
              <div className="col-span-2">
                <MetaRow
                  icon={<Hash size={11} />}
                  label="调度规则"
                  value={automation.rrule || automation.scheduled_at || '—'}
                  mono
                />
              </div>
              {(automation.valid_from || automation.valid_until) && (
                <div className="col-span-2">
                  <MetaRow
                    icon={<Clock size={11} />}
                    label="有效期"
                    value={`${automation.valid_from ?? '—'} ~ ${automation.valid_until ?? '—'}`}
                    mono
                  />
                </div>
              )}
              {automationLatestRun && (
                <div className="col-span-2">
                  <MetaRow
                    icon={<CircleDot size={11} />}
                    label="最近一次运行"
                    value={`${automationLatestRun.status}${
                      automationLatestRun.result_success === 1
                        ? ' · 成功'
                        : automationLatestRun.result_success === 0
                          ? ' · 失败'
                          : ''
                    } · ${fullTime(automationLatestRun.updated_at)}`}
                  />
                </div>
              )}
            </div>

            <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--hairline)' }}>
              <div className="text-[12.5px] font-mono mb-1.5 tracking-wider" style={{ color: '#475569' }}>
                PROMPT
              </div>
              <pre
                className="text-[14px] leading-relaxed whitespace-pre-wrap font-mono max-h-56 overflow-y-auto"
                style={{ color: '#a8b8d0' }}
              >
                {automation.prompt}
              </pre>
            </div>

            <div className="flex flex-wrap gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--hairline)' }}>
              <Button
                size="small"
                variant="outline"
                onClick={() => void copyText(automation.prompt, '指令内容')}
              >
                复制指令
              </Button>
              <Button
                size="small"
                variant="outline"
                onClick={() => void copyText(automation.id, '任务 ID')}
              >
                复制任务 ID
              </Button>
            </div>

            <div className="task-wait-notice" style={{ borderColor: 'rgba(148,163,184,0.35)' }}>
              <div className="task-wait-title" style={{ color: '#cbd5e1' }}>
                <AlertTriangle size={13} />
                这里只能查看，不能改
              </div>
              <div className="task-wait-body">
                自动化由 WorkBuddy 桌面端管理：官方接口只有「查询 / 新建 / 删除」、没有更新端点，
                看板也**保持对 WorkBuddy 只读**（不写它的任何数据）。
                要改时机 / 指令 / 启停，请到 WorkBuddy 的自动化面板编辑
                （上方「复制指令」可省去重打）。
              </div>
            </div>
          </>
        )}

        {/* ⚠️ 2026-09-15：「执行通道未连接」提示（serveRunning / serviceError）随
            CLI 派发通道下线移除 —— 本抽屉已无写操作，不存在"通道没连所以会失败"。
            详见 内部归档 */}

        {/* 上下文信息 */}
        {!automation && (
        <div
          className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-[13.5px]"
          style={{ borderBottom: '1px solid var(--hairline)', background: 'rgba(0,0,0,0.18)' }}
        >
          <MetaRow icon={<Cpu size={11} />} label="模型" value={session?.model ?? '—'} mono />
          <MetaRow icon={<FolderOpen size={11} />} label="工作目录" value={tailPath(cwd)} mono title={cwd} />
          <MetaRow
            icon={<Clock size={11} />}
            label="最近活动"
            value={fullTime(session?.last_activity_at ?? session?.updated_at)}
            mono
          />
          <MetaRow
            icon={<Hash size={11} />}
            label="会话"
            value={sessionId ? sessionId.slice(0, 12) : '—'}
            mono
            title={sessionId}
          />
        </div>
        )}

        {/* ============ 宿主正在等你选择（**只读展示**）============
            数据来自宿主会话记录里的 AskUserQuestion 调用（只读）。
            没有它，用户只看到"继续这个对话"却不知道要回答什么。

            ⚠️ 2026-09-15：原先这里还能**就地作答**（选项按钮 / 「其它答复」输入框 /
            提交按钮），走的是 CLI + ACP 通道。该通道已下线（见 内部归档）
            ⇒ 只保留**只读展示**：告诉你"它在问什么、有哪些选项"，作答请回 WorkBuddy。 */}
        {pendingQuestions.length > 0 && (
          <div className="px-4 pt-3.5">
            <div className="decision-panel">
              <div className="decision-panel-title">
                <AlertTriangle size={13} />
                WorkBuddy 正在等你选择
              </div>
              {session?.status === 'pending' && (
                <div
                  className="text-[12.5px] leading-relaxed mb-2.5 px-2 py-1.5 rounded"
                  style={{ background: 'rgba(52,211,153,0.08)', color: '#34d399' }}
                >
                  这条对话此刻正在 WorkBuddy 桌面端等你答复 ——
                  <b>请回 WorkBuddy 里点选</b>（看板已不再代你提交）。
                </div>
              )}
              {pendingQuestions.map((q, qi) => (
                <div key={qi} className="mb-3">
                  {(q.header || pendingQuestions.length > 1) && (
                    <div className="text-[12.5px] font-mono mb-1" style={{ color: '#94a3b8' }}>
                      {pendingQuestions.length > 1 && (
                        <span style={{ color: '#fbbf24' }}>
                          第 {qi + 1}/{pendingQuestions.length} 题　
                        </span>
                      )}
                      {q.header}
                    </div>
                  )}
                  <div className="text-[14.5px] leading-relaxed mb-2" style={{ color: '#fcd34d' }}>
                    {q.question}
                  </div>
                  {/* 只读：选项只展示，不可点（作答请回 WorkBuddy） */}
                  <div className="flex flex-col gap-1.5">
                    {q.options.map(opt => (
                      <div key={opt.label} className="decision-option text-left">
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-[12.5px] opacity-70 mt-0.5">
                            {opt.description}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="text-[12.5px] leading-relaxed mt-2" style={{ color: '#94a3b8' }}>
                选项仅作只读展示，看板不再代你提交 —— 请回 WorkBuddy 桌面端作答。
              </div>
            </div>
          </div>
        )}

        {/* 最近上下文（只读，帮助判断要不要接这个话茬） */}
        {tailMessages.length > 0 && (
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--hairline)' }}>
            <div
              className="text-[12.5px] font-mono mb-1.5 tracking-wider"
              style={{ color: '#475569' }}
            >
              RECENT CONTEXT
            </div>
            {tailMessages.map((m, i) => (
              <div key={i} className="text-[13px] leading-relaxed mb-1.5">
                <span
                  className="font-mono"
                  style={{ color: m.role === 'user' ? '#7dd3fc' : '#94a3b8' }}
                >
                  [{m.role === 'user' ? '你' : m.role === 'assistant' ? 'Agent' : m.role}]
                </span>{' '}
                <span style={{ color: '#94a3b8' }}>{m.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* ============ 执行中：实时活动流 ============
            用户要求：点开执行中的卡片要能看到**具体在执行什么**、滚动显示，
            而不是一个用不上的"继续对话"。数据来自宿主会话记录（只读），每 2.5s 拉一次。 */}
        {isLive && (
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--hairline)' }}>
            <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
              <span
                className="text-[12.5px] font-mono tracking-wider flex items-center gap-1.5"
                style={{ color: '#a78bfa' }}
              >
                <span className="term-cursor" />
                LIVE · {activity.length}
              </span>
              <span className="text-[11.5px] font-mono" style={{ color: '#475569' }}>
                {activityAt ? `记录更新于 ${hms(activityAt)}` : '等待活动…'} · 每 2.5s 刷新
              </span>
            </div>
            {activity.length === 0 ? (
              <div className="text-[13px] font-mono opacity-50">// 暂时读不到活动记录</div>
            ) : (
              <div ref={activityRef} className="host-activity">
                {activity.map((a, i) => (
                  <div
                    key={i}
                    className={`host-activity-line host-activity-line--${a.kind}${
                      a.isError ? ' host-activity-line--error' : ''
                    }`}
                  >
                    <span className="host-activity-time">{hms(a.at)}</span>
                    <span className="host-activity-text">
                      {a.kind === 'text'
                        ? `[${a.role === 'user' ? '你' : 'Agent'}] ${a.text}`
                        : a.kind === 'tool'
                          ? `▶ ${a.text}`
                          : a.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ⚠️ 2026-09-15：「这个实例卡住了」面板（REPLY_PRESETS 一键确认 + 直接回复）
            随 CLI 派发通道下线移除。它在等什么、有哪些选项，改由上面的
            「WorkBuddy 正在等你选择」只读面板展示；作答请回 WorkBuddy 桌面端。
            详见 内部归档 */}

        {/* ⚠️ 2026-09-15：「操作区」整块移除 —— 原先有 5 个按钮：
            继续这个对话 / 停止实例 / 重启实例 / 打开预览 / 查看对话原文，
            全部依赖 CLI 实例（job）与 serve 通道。该通道已下线（见 内部归档）
            ⇒ 本抽屉现在是**只读**的：看信息、看它在问什么、看实时活动流，不代你操作。 */}

        </div>
        {/* /task-drawer-body */}
      </div>
    </>
  );
};

const MetaRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  /** 值本身可以是节点（如「绝对时间 + 实时倒计时」两段） */
  value: React.ReactNode;
  /** 悬停提示；不传则不挂 title（value 为节点时用它做兜底是没意义的） */
  tip?: string;
  mono?: boolean;
  title?: string;
  /**
   * 强制单行省略。**默认不截断**（见下）。
   *
   * ⚠️ 2026-09-15 用户反馈「这里的信息显示不全，文字被截断了」：
   *   抽屉宽 `min(560px, 92vw)`，两列网格每列减掉 icon + label 后可用宽度仅约
   *   **180px**（约 22 个等宽字符），而实际值远超这个宽度 ——
   *     · 调度规则 `FREQ=DAILY;BYHOUR=12;BYMINUTE=30` ≈ 45 字符
   *     · 下次执行 `2026/9/16 12:30:00` + `还有 12h41m` ≈ 30 字符
   *     · 工作目录 `WorkBuddy/automation-2026-...` ≈ 30+ 字符
   *   ⇒ 统一 `truncate` 必然丢信息，只能靠悬停 title 补救（鼠标不动就看不到）。
   *   现在默认**折行显示完整值**，`nowrap` 仅留给确实要保持一行的短值。
   */
  nowrap?: boolean;
}> = ({ icon, label, value, mono, title, tip, nowrap }) => (
  <div className={`flex gap-1.5 min-w-0 ${nowrap ? 'items-center' : 'items-start'}`}>
    <span className={nowrap ? '' : 'mt-[3px]'} style={{ color: '#475569' }}>
      {icon}
    </span>
    <span className="shrink-0" style={{ color: '#64748b' }}>
      {label}
    </span>
    <span
      /**
       * `break-all` 而非 `break-words`：RRULE / 路径 / 模型名都是**无空格长串**，
       * 只按词断行的话整串找不到断点，会直接溢出容器（比截断更糟）。
       */
      className={`min-w-0 flex-1 ${nowrap ? 'truncate' : 'break-all'} ${mono ? 'font-mono' : ''}`}
      style={{ color: '#cbd5e1' }}
      title={tip ?? title ?? (typeof value === 'string' ? value : undefined)}
    >
      {value}
    </span>
  </div>
);

export default HostDrawer;
