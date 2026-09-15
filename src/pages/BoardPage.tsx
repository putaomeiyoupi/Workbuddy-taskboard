/**
 * BoardPage —— 任务看板主页面
 *
 * 组装：工具条 + 四列看板 + 新建任务对话框 + 工作空间管理 + 任务详情抽屉
 */

import React, { useCallback, useMemo, useState } from 'react';
import { MessagePlugin } from 'tdesign-react';
import {
  Plus,
  Settings2,
  RefreshCw,
  Activity,
  Timer,
  ListChecks,
  AlertTriangle,
  MessageSquare,
  Settings,
  Download,
  Zap,
  Loader2,
} from 'lucide-react';
import type { Task, BoardColumnKey, TaskStatus } from '../types';
import { useTasks } from '../hooks/useTasks';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useModels } from '../hooks/useModels';
import { TaskBoard } from '../components/board/TaskBoard';
import {
  HostSessionCard,
  HostAutomationCard,
  HostFinishedCard,
} from '../components/board/HostCard';
import { useSdkStatus } from '../hooks/useSdkStatus';
import { NewTaskDialog } from '../components/board/NewTaskDialog';
import { WorkspaceManager } from '../components/board/WorkspaceManager';
import { WorkspaceSyncDialog } from '../components/board/WorkspaceSyncDialog';
import { TaskDetailDrawer } from '../components/board/TaskDetailDrawer';
import { HostDrawer, type HostTarget } from '../components/board/HostDrawer';
import { BOARD_COLUMNS, columnOf, jobIsAwaiting, jobIsExecuting } from '../components/board/boardConfig';

interface BoardPageProps {
  /** 跳转到**看板任务**的完整会话（`task.session_id` 指向看板自己的 sessions 表 → `/chat/:id`） */
  onOpenSession?: (sessionId: string) => void;
  /** 跳转到**宿主会话**的完整记录（`HostSession.id` 指向宿主库 → `/host-session/:id`） */
  onOpenHostSession?: (sessionId: string) => void;
  /**
   * 判断某个看板会话是否仍然存在。
   * ⚠️ 用于防呆：会话已被清理时不该再给「查看完整对话」入口 ——
   *    否则点进去会渲染成「新对话」页，看起来像 bug。返回 false 时按钮置灰并说明原因。
   */
  taskSessionExists?: (sessionId: string) => boolean;
  /** 切换到对话页 */
  onOpenChat?: () => void;
  /** 切换到设置页 */
  onOpenSettings?: () => void;
}

export const BoardPage: React.FC<BoardPageProps> = ({
  onOpenSession,
  onOpenHostSession,
  taskSessionExists,
  onOpenChat,
  onOpenSettings,
}) => {
  const {
    tasks,
    connected,
    loading,
    error,
    host,
    createTask,
    deleteTask,
    moveToTodo,
    cancelTask,
    retryTask,
    triggerNow,
    // 定期循环控制（看板自建任务）
    toggleRepeatPause,
    clearRepeat,
    submitDecision,
    sendFollowup,
    fetchTranscript,
    updateTask,
    forceTick,
  } = useTasks();

  const {
    workspaces,
    schedulerStatus,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    updateGlobalConcurrency,
    fetchWorkspaceDiff,
    applyWorkspaceSync,
    refreshStatus,
  } = useWorkspaces();

  const { models, source: modelSource, selectedModel } = useModels();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  /** 点开的宿主任务/对话（抽屉目标） */
  const [hostTarget, setHostTarget] = useState<HostTarget | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showWorkspaces, setShowWorkspaces] = useState(false);
  const [showWorkspaceSync, setShowWorkspaceSync] = useState(false);

  /**
   * 宿主 = 只读镜像（绝不写入宿主库）。
   * 宿主会话是软删除过滤后的全量：
   *  - status='working' 且**没卡在等人** → 「进行中」
   *  - status='working' 但挂了 blocked job → 「待决策」
   *  - status ∈ completed/error（未归档、非运行中）→ 「已完成」（可继续）
   *  - automations → 「自动化定时」
   */
  const hostWorking = useMemo(() => host?.workingSessions ?? [], [host]);
  /**
   * 等用户回应的会话（宿主 status='pending'，桌面端显示「待确认」）→ 待决策列。
   * 注：「已有实例的会话」不在这里过滤 —— 那不是去重，是**换一张更准确的卡**，
   * 而且 `sessionsWithJob` 依赖上面的 CLI 桥接，这里还拿不到。过滤放在渲染处做。
   */
  const hostAwaiting = useMemo(() => host?.awaitingSessions ?? [], [host]);
  const hostFinished = useMemo(() => host?.finishedSessions ?? [], [host]);
  /**
   * 出错结束的会话 → 「待办」列（用户要求），带特别标志。
   *
   * ⚠️ 用户明确：这类**不进入调度** —— 不会自动跑，「调度」按钮也不会管它，
   * 只能点开卡片、在抽屉里手动「继续」触发。
   * 看板侧天然满足这一点：它们是**宿主会话**（不是看板任务），调度器只扫 tasks 表；
   * 这里把它写进注释，避免以后有人"顺手"把它们变成可调度的任务。
   */
  const hostErrored = useMemo(() => host?.errorSessions ?? [], [host]);

  /**
   * 「自动化定时」列的内容 —— **运行中的自动化不在这里**。
   *
   * 用户要求：同一张卡只能出现在一处 —— 要么「进行中」（正在跑），要么「自动化定时」（空闲待命）。
   * 自动化跑起来之后，它的运行会以宿主会话（`is_background_automation=1`）出现在「进行中」，
   * 此时再把配置卡留在定时列就成了"同一件事出现两次"。
   *
   * 判据来自宿主 `automation_runtime_state.running`（后端已回填为 `is_running`）。
   * 注：`hostAutomationsAll` 保留全量，供按 id 查找（如打开抽屉）时用。
   */
  const hostAutomationsAll = useMemo(() => host?.automations ?? [], [host]);
  const hostAutomations = useMemo(
    () => hostAutomationsAll.filter(a => !a.is_running),
    [hostAutomationsAll]
  );

  /**
   * Agent SDK 可用性：本机 CLI 非交互模式会挂起，导致 local 执行器不可用。
   * 状态来自后端探测缓存，据此禁用新建任务里的「本地」选项。
   */
  const sdk = useSdkStatus();

  /**
   * 打开某个宿主会话的上下文抽屉（**只读视图**）。
   *
   * ⚠️ 2026-09-15：原先这里还有一整套「CLI 实例（job）」派生逻辑 ——
   * 把 job 按「等人 / 在执行」拆开、据此把 SessionCard 分到待决策、以及 resume 后
   * 把抽屉切到新实例。CLI 派发通道已下线（见 `内部归档`）⇒ job 这层整体移除。
   *
   * 🔑 宿主「待决策」**不受影响**：它来自 `host.awaitingSessions`（宿主 `status='pending'`），
   * 与 CLI job 从来是两条独立来源 —— 删 job 不会让待决策列变空。
   */
  const openHostSession = useCallback(
    (session: (typeof hostWorking)[number]) => {
      setHostTarget({ session });
    },
    []
  );

  /** 打开某个宿主自动化定时任务（**只读**查看属性；改请到 WorkBuddy 面板） */
  const openHostAutomation = useCallback((automation: (typeof hostAutomations)[number]) => {
    setHostTarget({ automation });
  }, []);

  const selectedTask = useMemo(
    () => tasks.find(t => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );

  /** 计算任务的阻塞来源（仅待办列展示用） */
  const getBlockedBy = useCallback(
    (task: Task): string[] => {
      if (!Array.isArray(task.depends_on) || task.depends_on.length === 0) return [];
      return task.depends_on
        .map(depId => tasks.find(t => t.id === depId))
        .filter((t): t is Task => !!t && t.status !== 'done')
        .map(t => t.title);
    },
    [tasks]
  );

  /**
   * 选中任务（打开详情抽屉）。
   *
   * ⚠️ 必须用 `useCallback` 定住引用：这个函数会一路透传到 `TaskCard` 的 memo 比较里。
   *    之前这里传的是 inline 箭头 `onSelectTask={t => setSelectedTaskId(t.id)}`，
   *    **每次渲染都是新引用** ⇒ `TaskCard` 的 memo 恒定失效、全部卡片一起重渲染。
   *    （审计 H4；`setSelectedTaskId` 来自 `useState`，本身引用稳定，依赖数组留空是安全的。）
   */
  const handleSelectTask = useCallback((t: Task) => setSelectedTaskId(t.id), []);

  /**
   * 统计各板块数量（列键由 BOARD_COLUMNS 驱动，新增列不需要改这里）。
   *
   * 🔴 必须把**宿主卡片**也计进来。四列里都**混排**着宿主的会话/自动化卡片，
   *    而这里原先只遍历 `tasks`（看板自己的任务）⇒ 本机 tasks 为空时顶部栏恒显示
   *    「待办 0 / 进行中 0 / 待决策 0 / 自动化定时 0 / 已完成 0」，
   *    可列里的卡片却实实在在存在、连列头徽标都是对的 —— 两处数字互相打架。
   * ⇒ 口径与 `hostCounts` 完全一致，保证「顶部栏 = 列头 = 卡片数」。
   */
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const col of BOARD_COLUMNS) map[col.key] = 0;
    for (const t of tasks) {
      const col = columnOf(t);
      if (col) map[col] = (map[col] ?? 0) + 1;
    }
    map.todo = (map.todo ?? 0) + hostErrored.length;
    map.running = (map.running ?? 0) + hostWorking.length;
    map.pending_decision = (map.pending_decision ?? 0) + hostAwaiting.length;
    map.scheduled = (map.scheduled ?? 0) + hostAutomations.length;
    map.completed = (map.completed ?? 0) + hostFinished.length;
    return map;
  }, [tasks, hostErrored, hostWorking, hostAwaiting, hostAutomations, hostFinished]);

  /** 终态明细：列名叫「已完成」，但里面混着失败/取消，需要分别交代清楚 */
  const terminalCounts = useMemo(() => {
    const c = { done: 0, failed: 0, cancelled: 0 };
    for (const t of tasks) {
      if (t.status === 'done') c.done += 1;
      else if (t.status === 'failed') c.failed += 1;
      else if (t.status === 'cancelled') c.cancelled += 1;
    }
    return c;
  }, [tasks]);

  /** 卡片被拖到新板块 → 调用对应的状态流转 */
  const handleMoveTask = useCallback(
    async (task: Task, target: BoardColumnKey) => {
      if (target === 'running') {
        // 拖到「进行中」= 交给调度器处理，用户不能强行置为运行中
        if (task.status === 'scheduled') {
          await triggerNow(task.id);
          MessagePlugin.success('已立即触发，任务进入待办队列等待调度');
        } else {
          MessagePlugin.info('「进行中」由调度器控制，任务已保持在队列中');
        }
        return;
      }

      if (target === 'todo') {
        await moveToTodo(task.id);
        MessagePlugin.success('已移回待办');
        return;
      }

      if (target === 'pending_decision') {
        // 手动挂起为待决策
        await updateTask(task.id, {
          status: 'in_progress',
          run_state: 'waiting_approval',
          decision_prompt: '请补充该任务继续执行所需的信息',
        } as Partial<Task>);
        MessagePlugin.success('已挂起为待决策');
        return;
      }

      if (target === 'scheduled') {
        // 需要设定时间：默认 30 分钟后
        const when = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await updateTask(task.id, {
          status: 'scheduled',
          scheduled_at: when,
        } as Partial<Task>);
        MessagePlugin.success('已移入自动化定时（默认 30 分钟后执行）');
        return;
      }

      if (target === 'completed') {
        // 人工标记完成：终态由执行结果或用户确认决定，拖进来即视为确认
        await updateTask(task.id, {
          status: 'done',
          finished_at: new Date().toISOString(),
        } as Partial<Task>);
        MessagePlugin.success('已标记为完成');
        return;
      }
    },
    [moveToTodo, triggerNow, updateTask]
  );

  const handleCreateTask = useCallback(
    async (payload: Parameters<typeof createTask>[0]) => {
      const created = await createTask(payload);
      if (created) {
        MessagePlugin.success(
          payload.scheduled_at ? '定时任务已创建' : '任务已加入待办'
        );
      } else {
        MessagePlugin.error('创建失败');
      }
      return created;
    },
    [createTask]
  );

  return (
    <div className="board-surface h-full w-full flex flex-col min-h-0 relative">
      <div className="board-scanline" />

      {/* ============ 工具条 ============ */}
      <div
        className="relative z-10 flex items-center gap-3 px-4 py-3 flex-wrap"
        style={{ borderBottom: '1px solid var(--hairline)' }}
      >
        {/* 标题 */}
        <div className="flex items-center gap-2.5 mr-1">
          <span
            className="flex items-center justify-center w-7 h-7 rounded-md"
            style={{
              background: 'rgba(34,211,238,0.10)',
              border: '1px solid rgba(34,211,238,0.30)',
              boxShadow: '0 0 14px -4px rgba(34,211,238,0.7)',
            }}
          >
            <ListChecks size={15} style={{ color: '#22d3ee' }} />
          </span>
          <div>
            <div
              className="text-[15.5px] font-semibold leading-tight"
              style={{ color: '#e6f7ff', letterSpacing: '0.02em' }}
            >
              任务看板
            </div>
            <div
              className="text-[12px] font-mono leading-tight"
              style={{ color: '#475569', letterSpacing: '0.14em' }}
            >
              MISSION CONTROL
            </div>
          </div>
        </div>

        {/* 统计条 */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {BOARD_COLUMNS.map(col => (
            <span
              key={col.key}
              className="flex items-center gap-1.5 text-[13.5px] font-mono"
              style={{ color: '#64748b' }}
              title={col.description}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: col.accent,
                  boxShadow: `0 0 6px ${col.accent}`,
                }}
              />
              {col.title}
              <span style={{ color: col.accent, fontWeight: 600 }}>
                {counts[col.key] ?? 0}
              </span>
            </span>
          ))}
          {/*
            终态明细：列名叫「已完成」，但里面混着失败/取消，需要分别交代清楚。
            ⚠️ **必须无条件渲染**：这段在 `flex-wrap` 的统计条里，一旦按"是否全为 0"来显隐，
               出现/消失会改变整行宽度、触发换行与否 ⇒ 标题行高度跳动（用户实测反馈）。
            ⚠️ 颜色也不能太暗：原先是 #475569（slate-600），在深色底上几乎读不出来（用户反馈）。
               现在标签用 #94a3b8、数字用 #cbd5e1；**出现失败/取消时数字才变警示色**，
               既不惊悚又能一眼看到异常。
          */}
          <span
            className="text-[13.5px] font-mono"
            style={{ color: '#94a3b8' }}
            title="「已完成」列的终态细分（只统计看板自建任务，不含宿主会话）"
          >
            {'| '}完成{' '}
            <span style={{ color: '#cbd5e1' }}>{terminalCounts.done}</span>
            {' · '}失败{' '}
            <span style={{ color: terminalCounts.failed > 0 ? '#f87171' : '#cbd5e1' }}>
              {terminalCounts.failed}
            </span>
            {' · '}取消{' '}
            <span style={{ color: terminalCounts.cancelled > 0 ? '#fbbf24' : '#cbd5e1' }}>
              {terminalCounts.cancelled}
            </span>
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* 全局槽位：看板占用 + WorkBuddy 宿主在跑，合计才是真实占用 */}
          {schedulerStatus && (
            <SlotIndicator
              boardRunning={schedulerStatus.occupancy?.boardRunning ?? schedulerStatus.globalRunning}
              hostRunning={schedulerStatus.occupancy?.hostRunning ?? 0}
              limit={schedulerStatus.occupancy?.limit ?? schedulerStatus.globalConcurrency}
            />
          )}

          {/*
            实时事件流的连接状态。
            ⚠️ **只在断开时显示**：
              · 常态显示 `LIVE` 属于纯噪声（没坏就别报），而 7×24 挂着时它会一直在；
              · 断开时原来的措辞是 `OFFLINE`（红色），但它表达的是**SSE 事件流断了**，
                而不是"看板不可用" —— 实际看板仍每 5 秒 REST 对账、可正常使用，
                报一个红色 OFFLINE 会让人以为整个看板挂了（用户反馈：这个标志可以取消了）。
              所以改成：断开时给一条**措辞准确、颜色不惊悚（琥珀）**的提示，并说明影响范围；
              连上后自动消失。想彻底删掉这段，把下面的 `!connected &&` 整块去掉即可。
          */}
          {!connected && (
            <span
              className="board-conn board-conn--off"
              title={
                '实时事件流已断开，正在自动重连（约每 3 秒一次）。\n' +
                '期间看板数据仍每 5 秒对账一次，可以正常使用，只是刷新没那么即时。'
              }
            >
              <span className="board-conn-dot" />
              <span style={{ color: '#fbbf24' }}>实时流重连中</span>
            </span>
          )}

          <button
            className="board-toolbar-btn"
            onClick={async () => {
              const r = await forceTick();
              await refreshStatus();
              MessagePlugin.success(
                r && r.startedCount > 0
                  ? `调度器已启动 ${r.startedCount} 个任务`
                  : '已触发调度，本轮无新任务启动'
              );
            }}
            title="手动触发一次调度（调试用）"
          >
            <RefreshCw size={13} />
            调度
          </button>

          <button
            className="board-toolbar-btn"
            onClick={() => setShowWorkspaces(true)}
          >
            <Settings2 size={13} />
            工作空间
          </button>

          <button
            className="board-toolbar-btn"
            onClick={() => setShowWorkspaceSync(true)}
            title="查看与 WorkBuddy 的工作空间差异，再决定导入 / 移除（不静默改动）"
            style={{ borderColor: 'rgba(167,139,250,0.40)', color: '#c4b5fd' }}
          >
            <Download size={13} />
            同步空间
          </button>

          <button
            className="board-toolbar-btn"
            onClick={() => {
              setShowNewTask(true);
            }}
            style={{
              borderColor: 'rgba(34,211,238,0.40)',
              color: '#a5f3fc',
              background: 'rgba(34,211,238,0.08)',
            }}
          >
            <Plus size={13} />
            新建任务
          </button>

          {/* 「新建定时任务」按钮已移除（2026-09-15）：新建任务对话框里本就有
              「是否定时」的开关，单独再放一个入口是重复的。 */}

          {onOpenChat && (
            <button className="board-toolbar-btn" onClick={onOpenChat} title="切换到自由对话">
              <MessageSquare size={13} />
              对话
            </button>
          )}

          {onOpenSettings && (
            <button className="board-toolbar-btn" onClick={onOpenSettings} title="设置">
              <Settings size={13} />
            </button>
          )}
        </div>
      </div>

      {/* ============ 错误提示 ============ */}
      {error && (
        <div
          className="relative z-10 flex items-center gap-2 px-4 py-2 text-[14px] font-mono"
          style={{
            background: 'rgba(248,113,113,0.10)',
            borderBottom: '1px solid rgba(248,113,113,0.25)',
            color: '#fca5a5',
          }}
        >
          <AlertTriangle size={12} />
          {error}
        </div>
      )}

      {/* ============ 看板主体 ============
          这里必须是 flex 容器：TaskBoard 的网格靠 `flex-1 min-h-0` 拿到**确定的高度**，
          列才能内部滚动、而不把整页撑高（百分比高度在这种嵌套里会退化成 auto）。
          `overflow-x: auto` 负责「列被压到下限（280px）之后」的横向滚动 ——
          用户要求：卡片缩到刚好显示完全就别再缩，多出来的部分用横向滚动看。 */}
      <div
        className="relative z-10 flex-1 min-h-0 pt-3 flex"
        style={{ overflowX: 'auto', overflowY: 'hidden' }}
      >
        {loading && tasks.length === 0 ? (
          <div
            className="h-full flex flex-col items-center justify-center gap-3 font-mono text-[14.5px]"
            style={{ color: '#475569' }}
          >
            <span className="term-cursor">正在连接任务流</span>
            <span style={{ color: '#334155', fontSize: 13.5 }}>
              若长时间停留在此页面，说明后端服务未启动
            </span>
          </div>
        ) : !connected && !host?.available && tasks.length === 0 ? (
          /* 后端完全不可达：给出可操作的诊断，而不是空看板 */
          <div
            className="h-full flex flex-col items-center justify-center gap-4 font-mono"
            style={{ color: '#64748b' }}
          >
            <div style={{ color: '#f87171', fontSize: 15, letterSpacing: 1 }}>
              后端服务未连接
            </div>
            <div style={{ fontSize: 14.5, lineHeight: 1.9, textAlign: 'center' }}>
              看板未能连上 API，无法读取任务与 WorkBuddy 数据。
              <br />
              请在项目目录执行 <span style={{ color: '#c4b5fd' }}>start.cmd</span>（
              或 <span style={{ color: '#c4b5fd' }}>npm run dev</span>）后刷新本页。
            </div>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: 'rgba(167,139,250,0.12)',
                border: '1px solid rgba(167,139,250,0.5)',
                color: '#c4b5fd',
                borderRadius: 6,
                padding: '7px 18px',
                fontSize: 15,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              重新连接
            </button>
          </div>
        ) : (
          <TaskBoard
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            getBlockedBy={getBlockedBy}
            onSelectTask={handleSelectTask}
            onMoveTask={handleMoveTask}
            hostCards={{
              // 出错会话放「待办」：需要人过一眼；不会自动调度（见 hostErrored 注释）
              todo: hostErrored.map(s => (
                <HostFinishedCard
                  key={`host-err-${s.id}`}
                  session={s}
                  onOpen={openHostSession}
                />
              )),
              // 宿主正在跑的会话
              // （原先这里还排在最前面的「CLI 实例卡」已随派发通道下线移除，见 内部归档）
              running: hostWorking.map(s => (
                <HostSessionCard
                  key={`host-${s.id}`}
                  session={s}
                  live
                  onOpen={openHostSession}
                />
              )),
              // 宿主 status='pending'：WorkBuddy 里正在等你回答的对话 → 「待决策」
              // 🔑 这是「待决策」列里宿主会话的**唯一**来源，与已下线的 CLI job 无任何关系
              // （用户报的就是这一类 —— 此前看板压根没读这个状态，所以从没显示过）
              pending_decision: hostAwaiting.map(s => (
                <HostSessionCard
                  key={`host-pending-${s.id}`}
                  session={s}
                  live
                  awaiting
                  onOpen={openHostSession}
                />
              )),
              scheduled: hostAutomations.map(a => (
                <HostAutomationCard
                  key={`host-auto-${a.id}`}
                  automation={a}
                  latestRun={host?.latestRuns?.[a.id]}
                  onOpen={openHostAutomation}
                />
              )),
              // 未归档且已结束的 WorkBuddy 对话 —— 点开即可继续
              completed: hostFinished.map(s => (
                <HostFinishedCard
                  key={`host-done-${s.id}`}
                  session={s}
                  onOpen={openHostSession}
                />
              )),
            }}
            hostCounts={{
              todo: hostErrored.length,
              running: hostWorking.length,
              pending_decision: hostAwaiting.length,
              scheduled: hostAutomations.length,
              completed: hostFinished.length,
            }}
          />
        )}
      </div>

      {/* ============ 对话框与抽屉 ============ */}
      <NewTaskDialog
        visible={showNewTask}
        onClose={() => setShowNewTask(false)}
        onConfirm={handleCreateTask}
        workspaces={workspaces}
        models={models}
        tasks={tasks}
        defaultModel={selectedModel}
        defaultWorkspaceId={workspaces[0]?.id ?? null}
        sdkUnavailable={sdk.unavailable}
        sdkReason={sdk.status?.reason ?? null}
        modelSource={modelSource}
      />

      <WorkspaceManager
        visible={showWorkspaces}
        onClose={() => setShowWorkspaces(false)}
        workspaces={workspaces}
        status={schedulerStatus}
        onCreate={createWorkspace}
        onUpdate={updateWorkspace}
        onDelete={async (id: string) => {
          const ok = await deleteWorkspace(id);
          if (ok) MessagePlugin.success('已删除');
          return ok;
        }}
        onUpdateGlobalConcurrency={updateGlobalConcurrency}
        onOpenSync={() => {
          setShowWorkspaces(false);
          setShowWorkspaceSync(true);
        }}
      />

      <WorkspaceSyncDialog
        visible={showWorkspaceSync}
        onClose={() => setShowWorkspaceSync(false)}
        workspaces={workspaces}
        onFetchDiff={fetchWorkspaceDiff}
        onApply={applyWorkspaceSync}
      />

      <TaskDetailDrawer
        task={selectedTask}
        workspaces={workspaces}
        onClose={() => setSelectedTaskId(null)}
        onCancel={cancelTask}
        onRetry={retryTask}
        onMoveToTodo={moveToTodo}
        onTriggerNow={triggerNow}
        onDelete={deleteTask}
        onSubmitDecision={submitDecision}
        onFollowup={sendFollowup}
        onFetchTranscript={fetchTranscript}
        onOpenSession={onOpenSession}
        sessionExists={taskSessionExists}
        onToggleRepeatPause={toggleRepeatPause}
        onClearRepeat={clearRepeat}
      />

      {/* 宿主任务/对话：看上下文 + 就地授权 / 补充输入 / 继续 */}
      <HostDrawer
        target={hostTarget}
        automationLatestRun={
          hostTarget?.automation ? (host?.latestRuns?.[hostTarget.automation.id] ?? null) : null
        }
        onOpenFullSession={onOpenHostSession}
        onClose={() => setHostTarget(null)}
      />
    </div>
  );
};

/**
 * 全局并发槽位指示器
 * ============================================================
 * 用户反馈：「槽位数字没有变化，没有根据实际中的任务调整，哪怕是 WorkBuddy 中的任务」。
 *
 * 旧实现只数看板自己的 `in_progress` 任务，所以 WorkBuddy 里跑着东西时它仍是 0/N。
 * 现在把它做成**真实占用**：
 *   - 前 N 格（N = 全局上限）里，先填看板占用的（紫），再填宿主占用的（青）；
 *   - 超过上限的部分用琥珀色标出 —— 说明"实际在跑的事比配置的上限多"，
 *     这不是错误（宿主不受看板并发限制），但必须让人看见。
 */
const SlotIndicator: React.FC<{
  boardRunning: number;
  hostRunning: number;
  limit: number;
}> = ({ boardRunning, hostRunning, limit }) => {
  const safeLimit = Math.max(limit, 1);
  const total = boardRunning + hostRunning;
  const cells = Math.max(safeLimit, total);
  const over = total > safeLimit;

  const title = [
    '整机并发占用（看板 + WorkBuddy）',
    `看板调度占用：${boardRunning}/${safeLimit}`,
    `WorkBuddy 宿主在跑：${hostRunning}`,
    `合计：${total}${over ? `（超出配置上限 ${safeLimit}）` : ''}`,
    '注：并发上限是整机口径 —— 宿主机正在执行的任务同样占槽位，',
    '    所以 WorkBuddy 忙的时候看板可并行的任务会相应减少。',
  ].join('\n');

  return (
    <span
      className="flex items-center gap-2 text-[13.5px] font-mono slot-indicator"
      style={{ color: '#64748b' }}
      title={title}
    >
      <Activity size={12} />
      <span className="slot-track">
        {Array.from({ length: cells }).map((_, i) => {
          let cls = 'slot-cell';
          if (i >= safeLimit) cls += ' slot-cell--over';
          else if (i < boardRunning) cls += ' slot-cell--filled';
          else if (i < total) cls += ' slot-cell--host';
          return <span key={i} className={cls} />;
        })}
      </span>
      {/*
        ⚠️ 数字与「宿主 N」都要**固定占位**：
        数字位数变化（1/5 → 10/5）或"宿主 0 → 有值"都会改变这一段的宽度，
        而它在工具条的右对齐区域内 —— 一变宽整排按钮就会左右跳一下（用户报的"布局闪烁跳变"）。
        用等宽数字 + 固定宽度容器，并让宿主提示常驻（无值时用 visibility 隐藏而不是不渲染）。
      */}
      <span className="slot-ratio" style={{ color: over ? '#fbbf24' : '#a78bfa' }}>
        {total}/{safeLimit}
      </span>
      <span
        className="slot-host"
        style={{ color: '#22d3ee', visibility: hostRunning > 0 ? 'visible' : 'hidden' }}
        title="其中 WorkBuddy 宿主在跑的数量"
      >
        · 宿主 {hostRunning}
      </span>
    </span>
  );
};

export default BoardPage;
