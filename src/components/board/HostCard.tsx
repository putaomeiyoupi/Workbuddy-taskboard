/**
 * HostCard —— WorkBuddy 宿主数据的只读卡片
 *
 * 两种形态：
 *  - session  ：宿主正在执行/最近执行的会话（对应看板「进行中」板块）
 *  - automation：宿主的定时自动化（对应看板「自动化定时」板块）
 *
 * 设计约束：
 *  - 宿主数据一律**只读**，不提供任何修改入口（宿主库严禁写入）
 *  - 用明显的来源标记（WorkBuddy 徽标）与看板自有任务区分
 *  - 疑似僵尸会话（working 但长时间无活动）用警示色标注
 */

import React, { memo } from 'react';
import type { HostSession, HostAutomation, HostAutomationRun } from '../../types';
import {
  CircleDot,
  Clock,
  AlertTriangle,
  FolderOpen,
  Cpu,
  Zap,
  Loader2,
  CheckCircle2,
  XCircle,
  MessageSquareMore,
} from 'lucide-react';
import { formatRrule } from '../../utils/rrule';
import {
  untilTime as fmtUntilTime,
  agoTime as fmtAgoTime,
  hms as fmtHms,
  fullTime as fmtFullTime,
} from '../../utils/timeText';
import { useCountdownClock } from '../../hooks/useCountdownClock';
import { AWAIT_ACCENT, AWAIT_ACCENT_DIM } from './boardConfig';


/**
 * ⚠️ 时间文案与「秒级节拍」统一到共享模块（原先本文件各存一份）：
 *   - 文案：`src/utils/timeText.ts`（`untilTime` / `agoTime` / `hms` / `fullTime`）
 *   - 节拍：`src/hooks/useCountdownClock.ts`
 * 卡片与抽屉必须共用同一口径，否则同一任务在两处显示不同的话。
 */
const relativeTime = fmtAgoTime;
const untilTime = fmtUntilTime;
const hms = fmtHms;
const fullTime = fmtFullTime;

/** 路径末段，用于紧凑显示 */
function tailPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

/**
 * ============================================================================
 * 卡片按需字段比较（memo 的比较器）
 * ============================================================================
 * 为什么必须做（2026-09-15，用户要求 7×24 长期显示）：
 *
 *   宿主快照每次到达都是**全新对象**（`JSON.parse` 产物），所以
 *   `React.memo` 的默认浅比较（比 `props.session` 的引用）**永远判定为"变了"**，
 *   于是一张会话有更新 ⇒ 全部几十张卡片一起重渲染。
 *
 *   这不是"性能优化"，而是**稳定性问题**：实测 Microsoft Edge 153 在
 *   「大 DOM + 周期性整树重渲染」下约 35 秒崩渲染进程（STATUS_ACCESS_VIOLATION）；
 *   而同页面用纯 DOM 方式（不经过 React）每 3 秒改 500 个节点却完全正常 ⇒
 *   代价集中在 **React 为每张卡片做的重渲染工作**。把"每次更新重渲染 N 张卡"
 *   压到"只重渲染真正变了的那张"，单次工作量降一两个数量级。
 *
 * 比较口径 = **卡片真正渲染用到的字段**：多余字段（如 idleMs 这类派生量）变化
 * 不该触发重渲染，否则等于没优化。
 */

/** 会话卡片用到的字段 */
function sessionSig(s: HostSession): string {
  return [
    s.id,
    s.title,
    s.cwd,
    s.model,
    s.status,
    s.last_activity_at ?? '',
    s.updated_at,
    s.is_background_automation,
    s.isStale ? 1 : 0,
  ].join('\u0001');
}

/** 已完成卡片用到的字段（比执行中的少一项 last_activity_at） */
function finishedSig(s: HostSession): string {
  return [s.id, s.title, s.cwd, s.model, s.status, s.updated_at].join('\u0001');
}

/** 自动化卡片用到的字段 + 最近一次运行 */
function automationSig(a: HostAutomation, r?: HostAutomationRun): string {
  return [
    a.id,
    a.name,
    a.status,
    a.rrule ?? '',
    a.scheduled_at ?? '',
    a.next_run_at ?? '',
    a.model_id ?? '',
    (a.cwds ?? []).join(','),
    r?.result_success ?? '',
    r?.created_at ?? '',
    r?.updated_at ?? '',
  ].join('\u0001');
}

interface HostSessionCardProps {
  session: HostSession;
  /** 是否处于活跃执行中（status=working） */
  live?: boolean;
  /**
   * 该会话是否正卡在等人（挂了 blocked job）。
   * 命中时渲染成琥珀色，并归入看板「待决策」列。
   */
  awaiting?: boolean;
  /** 点击查看上下文并就地操作（授权 / 补充输入 / 继续）。传入的是稳定函数，卡片内部再绑 session */
  onOpen?: (session: HostSession) => void;
}

/** 宿主会话卡片（memo：只有本卡片渲染用到的字段变了才重渲染，见 sessionSig 说明） */
const HostSessionCardInner: React.FC<HostSessionCardProps> = ({
  session,
  live,
  awaiting,
  onOpen,
}) => {
  const stale = session.isStale === true;

  // 卡片内部自己绑 session ⇒ 外部只需传稳定函数，memo 才拦得住
  const onClick = React.useMemo(
    () => (onOpen ? () => onOpen(session) : undefined),
    [onOpen, session]
  );

  const accent = awaiting ? AWAIT_ACCENT : stale ? '#fbbf24' : '#a78bfa';
  const accentDim = awaiting
    ? AWAIT_ACCENT_DIM
    : stale
      ? 'rgba(251, 191, 36, 0.14)'
      : 'rgba(167, 139, 250, 0.14)';
  const statusText = awaiting ? '待确认' : stale ? '疑似挂起' : '执行中';

  return (
    <div
      className={`host-card ${onClick ? 'host-card--clickable' : ''}`}
      style={{
        ['--host-accent' as string]: accent,
        ['--host-accent-dim' as string]: accentDim,
      }}
      title={onClick ? '点击查看上下文并操作（宿主库只读，写操作走官方 API）' : '来自 WorkBuddy 宿主，只读展示'}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="host-card__glow" />

      <div className="host-card__header">
        <span className="host-card__badge">
          <Cpu size={11} strokeWidth={2} />
          WorkBuddy
        </span>
        <span className="host-card__status" style={{ color: accent }}>
          {awaiting ? (
            <AlertTriangle size={11} strokeWidth={2} />
          ) : stale ? (
            <AlertTriangle size={11} strokeWidth={2} />
          ) : (
            <CircleDot size={11} strokeWidth={2} />
          )}
          {statusText}
        </span>
      </div>

      <div className="host-card__title">{session.title || '(未命名会话)'}</div>

      <div className="host-card__meta">
        <span className="host-card__meta-item" title={session.cwd}>
          <FolderOpen size={11} strokeWidth={1.8} />
          {tailPath(session.cwd)}
        </span>
        {session.model && (
          <span className="host-card__meta-item">
            <Cpu size={11} strokeWidth={1.8} />
            {session.model}
          </span>
        )}
      </div>

      <div className="host-card__footer">
        <span className="host-card__meta-item">
          <Clock size={11} strokeWidth={1.8} />
          {live ? `${relativeTime(session.last_activity_at ?? session.updated_at)}活动` : relativeTime(session.updated_at)}
        </span>
        {session.is_background_automation === 1 && (
          <span className="host-card__tag">后台自动化</span>
        )}
      </div>
    </div>
  );
};

/**
 * 会话卡片：**按自己渲染用到的字段**比较，避免"一张会话更新 ⇒ 全部卡片重渲染"。
 * ⚠️ 不能只靠默认浅比较 —— `session` 每帧都是新对象（JSON 解析产物），引用永远不等。
 */
export const HostSessionCard = memo(
  HostSessionCardInner,
  (p, n) =>
    sessionSig(p.session) === sessionSig(n.session) &&
    p.live === n.live &&
    p.awaiting === n.awaiting &&
    p.onOpen === n.onOpen
);

// ============================================================
// 已结束但未归档的宿主会话 —— 「已完成」板块，可继续交代新要求
// ============================================================

interface HostFinishedCardProps {
  session: HostSession;
  /** 同 HostSessionCardProps.onOpen：传稳定函数，卡片内部绑 session */
  onOpen?: (session: HostSession) => void;
}

/**
 * 宿主已完成/出错的会话卡片。
 *
 * 这些会话既没在跑、也没归档 —— 正是用户「想找回来接着聊」的那批。
 * 点击后可从历史对话恢复成实例继续（官方 `POST /api/v1/jobs/resume`）。
 */
const HostFinishedCardInner: React.FC<HostFinishedCardProps> = ({ session, onOpen }) => {
  const onClick = React.useMemo(
    () => (onOpen ? () => onOpen(session) : undefined),
    [onOpen, session]
  );
  const errored = session.status === 'error';
  const accent = errored ? '#f87171' : '#34d399';
  const accentDim = errored ? 'rgba(248, 113, 113, 0.14)' : 'rgba(52, 211, 153, 0.14)';

  return (
    <div
      className={`host-card ${onClick ? 'host-card--clickable' : ''}`}
      style={{
        ['--host-accent' as string]: accent,
        ['--host-accent-dim' as string]: accentDim,
      }}
      title={
        errored
          ? '出错结束的对话 · 不会自动调度，点开在抽屉里手动「继续」'
          : '未归档的 WorkBuddy 对话 · 点击查看上下文并继续'
      }
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="host-card__glow" />

      <div className="host-card__header">
        <span className="host-card__badge">
          <Cpu size={11} strokeWidth={2} />
          WorkBuddy
        </span>
        <span className="host-card__status" style={{ color: accent }}>
          {errored ? (
            <XCircle size={11} strokeWidth={2} />
          ) : (
            <CheckCircle2 size={11} strokeWidth={2} />
          )}
          {errored ? '出错结束' : '已结束'}
        </span>
      </div>

      <div className="host-card__title">{session.title || '(未命名会话)'}</div>

      <div className="host-card__meta">
        <span className="host-card__meta-item" title={session.cwd}>
          <FolderOpen size={11} strokeWidth={1.8} />
          {tailPath(session.cwd)}
        </span>
        {session.model && (
          <span className="host-card__meta-item">
            <Cpu size={11} strokeWidth={1.8} />
            {session.model}
          </span>
        )}
      </div>

      <div className="host-card__footer">
        <span className="host-card__meta-item">
          <Clock size={11} strokeWidth={1.8} />
          {relativeTime(session.updated_at)}
        </span>
        <span className="host-card__tag" style={{ color: accent, borderColor: `${accent}59` }}>
          <MessageSquareMore size={10} strokeWidth={2} />
          {errored ? '需人工处理' : '可继续'}
        </span>
      </div>
    </div>
  );
};

interface HostAutomationCardProps {
  automation: HostAutomation;
  latestRun?: HostAutomationRun;
  /** 点击查看完整信息（只读；编辑请到 WorkBuddy）。传稳定函数，卡片内部绑 automation */
  onOpen?: (automation: HostAutomation) => void;
}

/** 宿主定时任务卡片（memo：见 automationSig 说明） */
const HostAutomationCardInner: React.FC<HostAutomationCardProps> = ({
  automation,
  latestRun,
  onOpen,
}) => {
  const onClick = React.useMemo(
    () => (onOpen ? () => onOpen(automation) : undefined),
    [onOpen, automation]
  );
  const paused = automation.status !== 'ACTIVE';
  const succeeded = latestRun?.result_success === 1;
  // 秒级节拍：进入 60 秒内时支持倒计时读秒（见 useCountdownClock 注释）
  const now = useCountdownClock(automation.next_run_at);

  return (
    <div
      className={`host-card ${onClick ? 'host-card--clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{
        ['--host-accent' as string]: paused ? '#64748b' : '#f472b6',
        ['--host-accent-dim' as string]: paused
          ? 'rgba(100, 116, 139, 0.14)'
          : 'rgba(244, 114, 182, 0.14)',
      }}
      title={onClick ? '点击查看完整信息（只读）' : '来自 WorkBuddy 宿主，只读展示'}
    >
      <div className="host-card__glow" />

      <div className="host-card__header">
        <span className="host-card__badge">
          <Cpu size={11} strokeWidth={2} />
          WorkBuddy
        </span>
        <span
          className="host-card__status"
          style={{ color: paused ? '#94a3b8' : '#f472b6' }}
        >
          <CircleDot size={11} strokeWidth={2} />
          {paused ? automation.status : '已启用'}
        </span>
      </div>

      <div className="host-card__title">{automation.name}</div>

      <div className="host-card__meta">
        <span className="host-card__meta-item">
          <Clock size={11} strokeWidth={1.8} />
          {formatRrule(automation.rrule || automation.scheduled_at)}
        </span>
      </div>

      {automation.cwds.length > 0 && (
        <div className="host-card__meta">
          <span className="host-card__meta-item" title={automation.cwds.join('\n')}>
            <FolderOpen size={11} strokeWidth={1.8} />
            {tailPath(automation.cwds[0])}
          </span>
        </div>
      )}

      <div className="host-card__footer">
        <span className="host-card__meta-item">
          {paused ? '下次' : '下次'} {untilTime(automation.next_run_at, now)}
        </span>
        {latestRun && (
          <span
            className="host-card__tag"
            style={{
              color: succeeded ? '#34d399' : '#f87171',
              borderColor: succeeded ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)',
            }}
          >
            上次{succeeded ? '成功' : '失败'}
          </span>
        )}
      </div>
    </div>
  );
};

/** 已完成会话卡片：按需字段比较（见 finishedSig） */
export const HostFinishedCard = memo(
  HostFinishedCardInner,
  (p, n) => finishedSig(p.session) === finishedSig(n.session) && p.onOpen === n.onOpen
);

/** 自动化卡片：按需字段比较（见 automationSig） */
export const HostAutomationCard = memo(
  HostAutomationCardInner,
  (p, n) =>
    automationSig(p.automation, p.latestRun) === automationSig(n.automation, n.latestRun) &&
    p.onOpen === n.onOpen
);

// ⚠️ 2026-09-15：本文件末尾原先还有「CLI job 卡片」（CliJobCard / CliJobCardProps /
// jobVisual）—— 那是 WorkBuddy 官方执行通道的实时实例卡，该通道已下线
// ⇒ 整块移除。宿主会话与自动化卡片不受影响。
