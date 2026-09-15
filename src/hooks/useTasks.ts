/**
 * useTasks —— 任务看板数据层
 *
 * 职责：
 *  - 通过 SSE (/api/tasks/stream) 订阅看板实时事件，保持任务列表最新
 *  - **周期性补偿核对**，弥补 SSE 漏事件（见下方 RECONCILE_INTERVAL_MS）
 *  - 提供任务 CRUD 与状态流转的操作封装
 *  - 维护选中任务的实时日志
 *
 * 设计要点：
 *  - 建连时后端会推一份 snapshot，前端无需额外首屏拉取
 *  - SSE 断线自动重连（3s 退避），保证长时间挂机不丢事件
 *  - 后端是唯一真源，核对时直接以后端结果覆盖本地
 */

import { useCallback, useEffect, useRef, useState } from 'react';
// 长时运行自愈：每次真正应用了一次宿主快照就记一笔，达到预算后重载清零（7×24 场景兜底）
import { countFullTreeUpdate } from '../utils/autoReload';
import type {
  Task,
  NewTaskPayload,
  BoardEvent,
  ProgressEntry,
  HostSnapshot,
} from '../types';

const API_BASE = '/api';

/** SSE 重连延迟 */
const RECONNECT_DELAY_MS = 3000;

/**
 * 补偿核对间隔。
 *
 * SSE 是主通道，但它在两种情况下会**漏事件**：
 *  1. 断线重连期间的窗口（重连成功前发生的事件不会补发）
 *  2. 浏览器把后台标签页的 EventSource 降频甚至挂起
 * 所以除实时事件外，每 5 秒与后端对一次账。
 * 页面从后台切回前台时也会立刻核对一次 —— 那正是最可能已经陈旧的时刻。
 */
const RECONCILE_INTERVAL_MS = 5000;

/**
 * 生成任务列表的廉价指纹，用于判断核对结果是否真的变了。
 * 没有变化就保留原数组引用，避免每 5 秒触发一次无意义的整树重渲染。
 */
function taskSignature(list: Task[]): string {
  return list.map(t => `${t.id}:${t.status}:${t.updated_at ?? ''}`).join('|');
}

export interface UseTasksResult {
  tasks: Task[];
  connected: boolean;
  loading: boolean;
  error: string | null;

  /** WorkBuddy 宿主数据快照（只读镜像） */
  host: HostSnapshot | null;
  /** 宿主快照是否已就绪 */
  hostLoading: boolean;

  /** 按板块筛选 */
  getTasksByStatus: (status: string) => Task[];

  createTask: (payload: NewTaskPayload) => Promise<Task | null>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<Task | null>;
  deleteTask: (id: string) => Promise<boolean>;

  /** 状态流转操作 */
  moveToTodo: (id: string) => Promise<Task | null>;
  cancelTask: (id: string) => Promise<Task | null>;
  retryTask: (id: string) => Promise<Task | null>;
  triggerNow: (id: string) => Promise<Task | null>;
  /** 暂停 / 恢复定期循环（暂停后仍留在「自动化定时」列，配置不丢） */
  toggleRepeatPause: (id: string, paused: boolean) => Promise<Task | null>;
  /** 关闭定期循环（配置清空；任务不再自动排下一轮） */
  clearRepeat: (id: string) => Promise<Task | null>;
  submitDecision: (id: string, answer: string) => Promise<Task | null>;
  requestDecision: (id: string, prompt: string, options?: string[]) => Promise<Task | null>;
  /**
   * 向执行中（或刚结束）的任务追加指令。
   * @returns 成功时返回后端给的投递方式说明（投递给活会话 / 暂存待投递）
   */
  sendFollowup: (id: string, text: string) => Promise<{ ok: boolean; mode?: string; error?: string }>;

  /**
   * 读取宿主侧的完整执行明细（官方 transcript，只读，最多最近 1000 行）。
   * 看板的 progress_log 是采样后的摘要，这里是原文，用于排查「看板看不出原因」的情况。
   */
  fetchTranscript: (id: string) => Promise<{ ok: boolean; updates?: unknown[]; error?: string }>;

  /** 手动触发一次调度（调试） */
  forceTick: () => Promise<{ startedCount: number } | null>;

  refresh: () => Promise<void>;
}

export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<HostSnapshot | null>(null);
  const [hostLoading, setHostLoading] = useState(true);

  const esRef = useRef<EventSource | null>(null);
  /**
   * 最近一次已应用到界面的宿主快照指纹。
   * 用于丢弃「内容和上一帧一样」的 host_snapshot（避免无意义地整树重渲染），
   * 详见 `handleEvent` 里 host_snapshot 分支的说明。
   */
  const lastHostHashRef = useRef<string>('');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUsRef = useRef(false);
  /** 最近一次已渲染列表的指纹，供补偿核对做无变化短路 */
  const signatureRef = useRef('');

  /**
   * 兜底规整：把任务上的「数组字段」强制成数组。
   *
   * 为什么前端还要做一遍（服务端已经序列化过）：这些字段在库里是 JSON **字符串**，
   * 只要有一条路径漏了序列化（历史上 SSE 事件就漏过），前端就会在渲染期抛
   * `f.map is not a function` —— 被 ErrorBoundary 兜住后**整块看板白屏**。
   * 界面不该因为一个字段形态不对就整个不可用，所以入口处再收一次口。
   */
  const normalizeTask = (t: Task): Task => {
    const asArray = (v: unknown): any[] => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string' && v.trim()) {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    };
    return {
      ...t,
      progress_log: asArray(t.progress_log),
      depends_on: asArray(t.depends_on),
      scopes: asArray(t.scopes),
      decision_options: asArray(t.decision_options),
    };
  };

  /** 合并单个任务到列表（新增或就地更新） */
  const upsertTask = useCallback((incoming: Task) => {
    incoming = normalizeTask(incoming);
    setTasks(prev => {
      const idx = prev.findIndex(t => t.id === incoming.id);
      if (idx === -1) {
        return [...prev, incoming];
      }
      const next = prev.slice();
      next[idx] = { ...next[idx], ...incoming };
      return next;
    });
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  /** 处理一条 SSE 事件 */
  const handleEvent = useCallback(
    (event: BoardEvent) => {
      const { type, payload } = event;

      switch (type) {
        case 'snapshot': {
          const list = ((payload.tasks as Task[]) || []).map(normalizeTask);
          setTasks(list);
          // 建连快照里同时带有宿主数据
          if (payload.host) {
            setHost(payload.host as HostSnapshot);
            setHostLoading(false);
          }
          setLoading(false);
          break;
        }
        case 'host_snapshot': {
          /**
           * 按服务端下发的指纹判重。
           *
           * ⚠️ 这一条是**必需**的，不是优化：`setHost` 传的是全新对象 ⇒
           *    BoardPage 里 `useMemo([host])` 全部重算 ⇒ 整棵宿主卡片子树重渲染。
           *    若服务端每 3 秒推一次"其实没变"的快照（历史 bug：指纹里含派生字段
           *    `idleMs`，每 tick 都涨 ⇒ 每 3 秒必推），前端就会每 3 秒白重渲染一次 ——
           *    实测在 Microsoft Edge 153 上约 35 秒直接崩渲染进程（STATUS_ACCESS_VIOLATION）。
           *
           * 服务端已在更上游修掉了"假变化"；这里再按指纹兜一层，
           * 保证「服务端说没变 ⇒ 前端一定不重渲染」。
           */
          const hash = event.hash;
          if (hash) {
            if (hash === lastHostHashRef.current) break;
            lastHostHashRef.current = hash;
          }
          setHost(payload as unknown as HostSnapshot);
          setHostLoading(false);
          /**
           * 记一次「整树更新已应用」给长时运行自愈（`src/utils/autoReload.ts`）。
           * ⚠️ 必须在**真正 setHost 之后**调用 —— 被判重丢掉的帧不重渲染，不该计数。
           */
          countFullTreeUpdate();
          break;
        }
        case 'task_created':
        case 'task_updated':
        case 'task_started':
        case 'task_progress':
        case 'task_finished':
        case 'task_decision_required': {
          if (payload.task) upsertTask(payload.task as Task);
          break;
        }
        case 'task_deleted': {
          if (payload.taskId) removeTask(payload.taskId as string);
          break;
        }
        default:
          break;
      }
    },
    [upsertTask, removeTask]
  );

  /** 建立 SSE 连接 */
  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource(`${API_BASE}/tasks/stream`);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onmessage = e => {
      try {
        const event = JSON.parse(e.data) as BoardEvent;
        handleEvent(event);
      } catch (err) {
        console.warn('[useTasks] 事件解析失败', err);
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;

      if (closedByUsRef.current) return;

      // 退避重连
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, RECONNECT_DELAY_MS);
    };
  }, [handleEvent]);

  useEffect(() => {
    closedByUsRef.current = false;
    connect();

    return () => {
      closedByUsRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [connect]);

  /** 兜底拉取（SSE 不可用时） */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/tasks`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Task[];
      setTasks(data.map(normalizeTask));
      setError(null);
    } catch (err: any) {
      setError(err?.message || '加载任务失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /* ---------- 周期性补偿核对 ---------- */

  // 每次列表变化后更新指纹
  useEffect(() => {
    signatureRef.current = taskSignature(tasks);
  }, [tasks]);

  /**
   * 与后端对账。失败**静默**处理：SSE 可能仍在正常工作，
   * 一次核对失败不该弹错误打扰用户。
   */
  const reconcile = useCallback(async () => {
    // 后台标签页不做无谓请求；切回前台时由 visibilitychange 立即补一次
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    try {
      const res = await fetch(`${API_BASE}/tasks`);
      if (!res.ok) return;
      const data = (await res.json()) as Task[];

      // 无变化则保持原引用，避免每 5 秒一次无意义的重渲染
      if (taskSignature(data) === signatureRef.current) return;

      signatureRef.current = taskSignature(data);
      setTasks(data.map(normalizeTask));
      setLoading(false);
    } catch {
      // 静默：网络抖动或后端重启期间不打扰用户
    }
  }, []);

  // 定时核对
  useEffect(() => {
    const timer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reconcile]);

  // 从后台切回前台时立刻核对一次
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconcile();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [reconcile]);

  // SSE 连接失败 8 秒后仍无数据，走一次 REST 兜底
  useEffect(() => {
    const timer = setTimeout(() => {
      if (tasks.length === 0 && loading) {
        refresh();
      }
    }, 8000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 通用请求封装 ---------- */

  const request = useCallback(
    async (url: string, init?: RequestInit): Promise<any> => {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      return res.json();
    },
    []
  );

  /* ---------- CRUD ---------- */

  const createTask = useCallback(
    async (payload: NewTaskPayload): Promise<Task | null> => {
      try {
        const task = (await request(`${API_BASE}/tasks`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })) as Task;
        upsertTask(task);
        return task;
      } catch (err: any) {
        setError(err?.message || '创建任务失败');
        return null;
      }
    },
    [request, upsertTask]
  );

  const updateTask = useCallback(
    async (id: string, patch: Partial<Task>): Promise<Task | null> => {
      try {
        const task = (await request(`${API_BASE}/tasks/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })) as Task;
        upsertTask(task);
        return task;
      } catch (err: any) {
        setError(err?.message || '更新任务失败');
        return null;
      }
    },
    [request, upsertTask]
  );

  const deleteTask = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await request(`${API_BASE}/tasks/${id}`, { method: 'DELETE' });
        removeTask(id);
        return true;
      } catch (err: any) {
        setError(err?.message || '删除任务失败');
        return false;
      }
    },
    [request, removeTask]
  );

  /* ---------- 状态流转 ---------- */

  const makeAction = useCallback(
    (suffix: string, body?: Record<string, unknown>) =>
      async (id: string): Promise<Task | null> => {
        try {
          const task = (await request(`${API_BASE}/tasks/${id}/${suffix}`, {
            method: 'POST',
            body: body ? JSON.stringify(body) : undefined,
          })) as Task;
          upsertTask(task);
          return task;
        } catch (err: any) {
          setError(err?.message || '操作失败');
          return null;
        }
      },
    [request, upsertTask]
  );

  const moveToTodo = useCallback(
    (id: string) => makeAction('to-todo')(id),
    [makeAction]
  );

  const cancelTask = useCallback(
    (id: string) => makeAction('cancel')(id),
    [makeAction]
  );

  const retryTask = useCallback(
    (id: string) => makeAction('retry')(id),
    [makeAction]
  );

  const triggerNow = useCallback(
    (id: string) => makeAction('trigger-now')(id),
    [makeAction]
  );

  /**
   * 暂停 / 恢复定期循环。
   * ⚠️ 恢复时是后端**重算**下次时间（不是沿用暂停前的旧时间）——
   *    详见 `server/scheduler.ts` 的 `resumeRepeatSchedule` 注释。
   */
  const toggleRepeatPause = useCallback(
    (id: string, paused: boolean) => makeAction('repeat/pause', { paused })(id),
    [makeAction]
  );

  /** 关闭定期循环（配置清空；任务不再自动排下一轮） */
  const clearRepeat = useCallback(
    (id: string) => makeAction('repeat', { repeat_mode: 'none' })(id),
    [makeAction]
  );

  const submitDecision = useCallback(
    (id: string, answer: string) => makeAction('decide', { answer })(id),
    [makeAction]
  );

  const requestDecision = useCallback(
    (id: string, prompt: string, options?: string[]) =>
      makeAction('request-decision', { prompt, options })(id),
    [makeAction]
  );

  /**
   * 跟进：向执行中的宿主任务追加指令。
   * 返回值带 mode（投递给活会话 / 暂存待投递），由调用方决定怎么提示用户；
   * 失败时**不抛异常**，把错误文案交回给组件，便于保留用户已输入的内容。
   */
  const sendFollowup = useCallback(
    async (id: string, text: string) => {
      try {
        const res = (await request(`${API_BASE}/tasks/${id}/followup`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        })) as { ok?: boolean; mode?: string };
        return { ok: res?.ok !== false, mode: res?.mode };
      } catch (err: any) {
        return { ok: false, error: err?.message || '跟进失败' };
      }
    },
    [request]
  );

  /**
   * 读取宿主执行明细。失败不抛异常，把错误交回组件展示。
   */
  const fetchTranscript = useCallback(
    async (id: string) => {
      try {
        const res = (await request(`${API_BASE}/tasks/${id}/transcript`)) as { updates?: unknown[] };
        return { ok: true, updates: res?.updates ?? [] };
      } catch (err: any) {
        return { ok: false, error: err?.message || '读取执行明细失败' };
      }
    },
    [request]
  );

  /* ---------- 调度 ---------- */

  const forceTick = useCallback(async () => {
    try {
      const result = await request(`${API_BASE}/scheduler/tick`, { method: 'POST' });
      return result as { startedCount: number };
    } catch (err: any) {
      setError(err?.message || '触发调度失败');
      return null;
    }
  }, [request]);

  /* ---------- 派生 ---------- */

  const getTasksByStatus = useCallback(
    (status: string) => tasks.filter(t => t.status === status),
    [tasks]
  );

  return {
    tasks,
    connected,
    loading,
    error,
    host,
    hostLoading,
    getTasksByStatus,
    createTask,
    updateTask,
    deleteTask,
    moveToTodo,
    cancelTask,
    retryTask,
    triggerNow,
    toggleRepeatPause,
    clearRepeat,
    submitDecision,
    requestDecision,
    sendFollowup,
    fetchTranscript,
    forceTick,
    refresh,
  };
}

export type { ProgressEntry };
