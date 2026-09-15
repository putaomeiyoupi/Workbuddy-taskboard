/**
 * 宿主会话「完整对话」视图（只读）
 * ============================================================================
 * 背景（用户报的 bug，第二次反馈）：
 *   抽屉里的「查看完整对话」原先调用 `onOpenSession(sessionId)` → 跳到 `/chat/<id>`，
 *   但那条 id 是**宿主会话**的 id，看板自己的 `sessions`（data/chat.db）里根本没有它
 *   → `currentSession === undefined` → ChatPage 的 `showNewChatView` 第一条件为真
 *   → 渲染出「新对话」页（大标题是 APP_NAME「任务看板」），用户以为点错了。
 *
 * 为什么不在 ChatPage 里加分支：
 *   看板自己的对话（可发消息、有权限交互）与宿主会话的只读镜像**是两种东西**，
 *   塞进一个组件会让两边的状态机互相污染。所以给它一条独立路由 `/host-session/:id`。
 *
 * 数据来源：`GET /api/host/sessions/:id/transcript?mode=full`
 *   —— 只读宿主 `projects/<slug>/<sessionId>.jsonl`，**不写宿主任何东西**。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, MessagePlugin } from 'tdesign-react';
import { ArrowLeft, RefreshCw, Terminal, Loader2 } from 'lucide-react';

/** 与服务端 hostTranscript.ActivityEntry 对应 */
interface ActivityEntry {
  kind: 'text' | 'tool' | 'tool_result';
  text: string;
  at?: number;
  role?: 'user' | 'assistant' | 'system';
  isError?: boolean;
}

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

interface TranscriptData {
  sessionId: string;
  file?: string;
  pending: { questions: PendingQuestion[]; toolCallId?: string } | null;
  tail: Array<{ role: string; text: string; at?: number }>;
  recent: ActivityEntry[];
  updatedAt?: number;
  /** 只展示了一部分时才有（文件过大 / 活动条数被上限截断） */
  partial?: { fileTooLarge?: boolean; activityCapped?: boolean; totalEntries?: number; shown?: number };
  error?: string;
}

interface HostSessionMeta {
  id: string;
  title?: string;
  status?: string;
  cwd?: string;
  updated_at?: number;
  last_activity_at?: number;
}

/** 毫秒 → HH:MM:SS */
function hms(ts?: number): string {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 毫秒 → 本地完整时间 */
function fullTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

export function HostSessionChatView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<HostSessionMeta | null>(null);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** 上次已应用的内容指纹 —— 相同则跳过 setState（见 load 里的说明） */
  const sigRef = useRef<string>('');
  /** 首次加载后自动滚到底；之后只在用户本来就在底部时才跟随，避免打断向上翻阅 */
  const stickToBottom = useRef(true);

  const load = useCallback(
    async (showSpinner = false) => {
      if (!sessionId) return;
      if (showSpinner) setLoading(true);
      try {
        const [tRes, sRes] = await Promise.all([
          fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/transcript?mode=full`),
          fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}`),
        ]);
        const tJson = await tRes.json();
        const sJson = sRes.ok ? await sRes.json() : null;

        /**
         * ⚠️ 内容判重后再 setState（与 `useTasks` / `useWorkspaces` 同一纪律）。
         *   本页在会话运行中每 2.5s 轮询一次；`fetch().json()` 每次都是新引用，
         *   无条件 setState 会让整页（含几百行活动流）每 2.5 秒重渲染一次。
         *   实测教训：Edge 153 在"大 DOM + 周期性整树重渲染"下会崩渲染进程
         *   （STATUS_ACCESS_VIOLATION）—— 见 scripts/probe-render-storm.py 的说明。
         *   会话真的在动时 transcript 内容会变，判重不会吞掉真实更新。
         */
        const sig = JSON.stringify(tJson) + '\u0001' + JSON.stringify(sJson?.session ?? null);
        if (sig !== sigRef.current) {
          sigRef.current = sig;
          setData(tJson);
          setError(tJson?.error ?? null);
          if (sJson) setMeta(sJson?.session ?? null);
        }
      } catch (e: any) {
        setError(e?.message ?? '读取失败');
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [sessionId]
  );

  // 初次加载
  useEffect(() => {
    stickToBottom.current = true;
    load(true);
  }, [load]);

  // 首屏数据到位后滚到底
  useEffect(() => {
    if (loading || !data) return;
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [loading, data]);

  // 会话仍在进行时自动刷新（与抽屉实时流一致：2.5s）
  useEffect(() => {
    const live = meta?.status === 'working' || Boolean(data?.pending);
    if (!live) return undefined;
    const id = setInterval(() => load(false), 2500);
    return () => clearInterval(id);
  }, [meta?.status, data?.pending, load]);

  const entries = data?.recent ?? [];

  return (
    <div className="flex flex-col h-full min-h-0" style={{ backgroundColor: 'var(--td-bg-color-page)' }}>
      {/* 顶部：返回 + 标题 + 刷新（本页只读，故不给任何写操作按钮） */}
      <div
        className="flex items-center gap-3 px-4 py-3 shrink-0 flex-wrap"
        style={{ borderBottom: '1px solid var(--hairline)' }}
      >
        <Button
          size="small"
          variant="outline"
          icon={<ArrowLeft size={12} />}
          onClick={() => navigate('/board')}
        >
          返回看板
        </Button>

        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] font-medium truncate">{meta?.title || '宿主会话'}</div>
          <div className="text-[11.5px] font-mono truncate" style={{ color: '#64748b' }}>
            {sessionId}
            {meta?.status ? ` · ${meta.status}` : ''}
            {data?.updatedAt ? ` · 记录更新于 ${hms(data.updatedAt)}` : ''}
          </div>
        </div>

        <span
          className="text-[11.5px] font-mono px-2 py-1 rounded"
          style={{ color: '#94a3b8', border: '1px solid var(--hairline)' }}
          title="本视图只读：数据来自 WorkBuddy 会话记录，看板不会写入宿主任何内容"
        >
          只读
        </span>

        <Button size="small" variant="outline" icon={<RefreshCw size={12} />} onClick={() => load(true)}>
          刷新
        </Button>
      </div>

      {/* 元信息条 */}
      {meta?.cwd && (
        <div
          className="px-4 py-2 text-[12px] font-mono shrink-0 truncate"
          style={{ borderBottom: '1px solid var(--hairline)', color: '#64748b' }}
          title={meta.cwd}
        >
          cwd · {meta.cwd}
        </div>
      )}

      {/* 待回答的提问：原样展示（本页只读，回答请去 WorkBuddy 桌面端） */}
      {data?.pending && data.pending.questions.length > 0 && (
        <div
          className="px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--hairline)', background: 'rgba(168,85,247,0.08)' }}
        >
          <div className="text-[12.5px] font-mono mb-2" style={{ color: '#c084fc' }}>
            等你在 WorkBuddy 里回答（看板只读展示）
          </div>
          {data.pending.questions.map((q, i) => (
            <div key={i} className="mb-2 last:mb-0">
              {q.header && (
                <div className="text-[11.5px] font-mono mb-0.5" style={{ color: '#94a3b8' }}>
                  {q.header}
                </div>
              )}
              <div className="text-[13.5px] mb-1.5">{q.question}</div>
              <div className="flex flex-col gap-1">
                {q.options.map((o, j) => (
                  <div
                    key={j}
                    className="text-[12.5px] px-2.5 py-1.5 rounded"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--hairline)' }}
                  >
                    <span style={{ color: '#e2e8f0' }}>{o.label}</span>
                    {o.description && (
                      <span style={{ color: '#94a3b8' }}> · {o.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 诚实提示：只展示了一部分时明说，别让用户以为这就是全部 */}
      {data?.partial && (
        <div
          className="px-4 py-2 text-[12px] shrink-0"
          style={{
            borderBottom: '1px solid var(--hairline)',
            background: 'rgba(245,158,11,0.10)',
            color: '#fbbf24',
          }}
        >
          {data.partial.fileTooLarge && '会话记录文件超过读取上限，仅显示最近部分。'}
          {data.partial.fileTooLarge && data.partial.activityCapped && ' '}
          {data.partial.activityCapped &&
            `共 ${data.partial.totalEntries ?? '?'} 条活动，这里显示最近 ${data.partial.shown ?? 0} 条。`}
        </div>
      )}

      {/* 对话正文 */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
        onScroll={e => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {loading ? (
          <div className="flex items-center gap-2 text-[13px] font-mono" style={{ color: '#64748b' }}>
            <Loader2 size={13} className="animate-spin" />
            正在读取会话记录…
          </div>
        ) : error ? (
          <div className="text-[13px] font-mono" style={{ color: '#f87171' }}>
            // {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="text-[13px] font-mono" style={{ color: '#64748b' }}>
            // 这条会话还没有可展示的记录
          </div>
        ) : (
          <div className="host-activity">
            {entries.map((a, i) => (
              <div
                key={i}
                className={`host-activity-line host-activity-line--${a.kind}${
                  a.isError ? ' host-activity-line--error' : ''
                }`}
              >
                <span className="host-activity-time">{hms(a.at)}</span>
                <span className="host-activity-text">
                  {a.kind === 'text'
                    ? `[${a.role === 'user' ? '你' : a.role === 'system' ? '系统' : 'Agent'}] ${a.text}`
                    : a.kind === 'tool'
                      ? `▶ ${a.text}`
                      : a.text}
                </span>
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 底部说明：本页只读 */}
      <div
        className="px-4 py-2.5 text-[12px] shrink-0 flex items-center gap-2"
        style={{ borderTop: '1px solid var(--hairline)', color: '#64748b' }}
      >
        <Terminal size={12} />
        只读视图 · 要回复或授权请在 WorkBuddy 桌面端操作
        <button
          type="button"
          className="ml-auto underline"
          style={{ color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}
          onClick={() => {
            navigator.clipboard?.writeText(sessionId ?? '').then(
              () => MessagePlugin.success('已复制会话 ID'),
              () => MessagePlugin.error('复制失败')
            );
          }}
        >
          复制会话 ID
        </button>
      </div>
    </div>
  );
}
