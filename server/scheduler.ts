/**
 * WSML-P 调度引擎
 * ============================================================
 * Workspace-Mutex, Priority-weighted, Slot-limited
 *
 * 三重约束：
 *   ① 依赖满足    —— 前置任务全部 done 才可启动
 *   ② 工作空间互锁 —— 同一 workspace 内 running 数 < 该空间 max_concurrency
 *   ③ 全局资源槽   —— 全局 running 数 < global_concurrency（可配置，默认 3）
 *
 * tick 循环（默认 3s）：
 *   1. 提升：scheduled 且到点 → todo
 *   2. 回收：running 但执行器已消失 → 判定终态
 *   3. 调度：todo 按 (priority DESC, sort_order ASC, created_at ASC) 排序，
 *            逐个检查三重约束，通过则启动执行
 */

import { EventEmitter } from 'events';
import { anyOverlap } from './scopes.js';
import { serializeTask } from './taskView.js';
import { getOccupancy } from './hostOccupancy.js';
import { decideAfterRun, describeTaskRepeat, normalizeRepeatMode, specFromTask, computeNextRun } from './repeat.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getAllTasks,
  getTask,
  updateTask,
  createTask,
  createWorkspace,
  getAllWorkspaces,
  getWorkspace,
  // 「有意停住」状态集合 —— 与 index.ts 的守卫共用同一真源（见 db.ts 注释）
  PARKED_RUN_STATES,
  getDueScheduledTasks,
  countTasksInWorkspace,
  countTasksByStatuses,
  getGlobalConcurrency,
  getDependencies,
  getScopes,
  createTaskRun,
  listTaskRuns,
  createInteraction,
  resolveInteraction,
  getPendingInteraction,
  getLatestResolvedInteraction,
  parseInteractionAnswer,
  cancelPendingInteractions,
  type DbTask,
  type DbWorkspace,
  type TaskStatus,
} from './db.js';

/**
 * 稳定的短哈希（djb2），用于把「问题正文」变成 requestId 的一部分。
 * 目的：同一 job 反复提出**同一个问题**时只建一条交互（幂等），
 * 提出**新问题**时则是一条新交互。
 */
function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
import { runTaskAgent, cancelTaskApproval, clearLiveQuery, type TaskRunHandle } from './taskRunner.js';
import { isPermissionGrant, looksLikePermissionDenied } from './permission.js';
import { isSdkKnownUnavailable, getSdkStatus } from './sdkStatus.js';

/** 调度 tick 间隔（毫秒） */
const TICK_INTERVAL_MS = 3000;

/** 看板事件总线：调度器产生的所有状态变更都会广播出去，供 SSE 端点订阅 */
export const boardEvents = new EventEmitter();
boardEvents.setMaxListeners(100);

/**
 * 广播一个看板事件。
 *
 * ⚠️ **这里必须把 task 序列化**（2026-09-14 踩过，代价是整块看板白屏）：
 * 本文件各处习惯写 `emitBoardEvent(..., { task: getTask(task.id) })`，
 * 而 `getTask()` 返回的是**数据库原始行** —— 其中的 `progress_log` / `scopes` /
 * `depends_on` 都是 JSON **字符串**。前端把它们当数组用
 * （`progress_log.slice(-3).map(...)`），于是渲染期抛
 * `f.map is not a function`，被 ErrorBoundary 兜成「界面渲染出错」，
 * **整个看板不可用**。
 *
 * 这个 bug 潜伏了很久：只要待办列真有任务被调度（进而发出 task_started /
 * task_progress），就会触发。所以修法不是"把每个调用点都补一遍 serialize"，
 * 而是在**唯一的出口**上过一道 —— 让漏写在结构上不可能发生。
 */
export function emitBoardEvent(type: string, payload: Record<string, any>): void {
  const safePayload =
    payload && payload.task ? { ...payload, task: serializeTask(payload.task) } : payload;
  boardEvents.emit('event', { type, payload: safePayload, at: new Date().toISOString() });
}

/** 正在执行中的任务句柄映射 */
const runningHandles = new Map<string, TaskRunHandle>();

let tickTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

// ============================================================
// 对外查询
// ============================================================

/** 获取当前运行中的任务 ID 列表 */
export function getRunningTaskIds(): string[] {
  return Array.from(runningHandles.keys());
}

/** 判断调度器是否已启动 */
export function isSchedulerRunning(): boolean {
  return tickTimer !== null;
}

/**
 * 中止一个正在运行的任务。
 * 返回是否找到并成功中止了执行句柄。
 */
export function abortRunningTask(taskId: string): boolean {
  const handle = runningHandles.get(taskId);
  if (!handle) return false;
  try {
    handle.abort();
  } catch (err) {
    console.error(`[Scheduler] 中止任务失败 (${taskId}):`, err);
  }
  runningHandles.delete(taskId);
  return true;
}

// ============================================================
// 定期循环
// ============================================================

/**
 * 循环任务「本轮结束 → 排下一轮」。
 *
 * 语义（与用户确认过的口径）：
 *   - 每执行完一轮，`repeat_count` +1，并算出下一次时刻写回 `scheduled_at`，
 *     状态回到 `scheduled` ⇒ 任务重新出现在「自动化定时」列等下一轮。
 *     每轮的明细留在 `task_runs` 里（`startTask` 每轮新开一条 run）。
 *   - 达到 `repeat_limit`、或下一次时刻晚于 `repeat_until` ⇒ 收尾：
 *     不再排下一轮，任务按本轮的真实结果留在终态（「已完成」列）。
 *   - **暂停不影响计数与排期**，只影响调度器是否触发（见 `runTick` 阶段 1）。
 *
 * ⚠️ 调用方必须**在终态写入之后**调用本函数（原因见 `onFinish` 里的注释）。
 */
export function rescheduleRepeatAfterRun(
  taskId: string,
  now: Date = new Date()
): { rescheduled: boolean; exhausted: boolean; reason?: string; nextAt?: string | null; runsDone?: number } {
  const task = getTask(taskId);
  if (!task || normalizeRepeatMode(task.repeat_mode) === 'none') {
    return { rescheduled: false, exhausted: true };
  }

  const decision = decideAfterRun(task, now);
  const finishedAt = now.toISOString();

  if (decision.exhausted) {
    updateTask(taskId, {
      repeat_count: decision.runsDone,
      repeat_last_at: finishedAt,
      // 已收尾 ⇒ 清掉排期：虽然终态任务本来就不会被 `getDueScheduledTasks` 捞到
      //（它要求 status='scheduled'），但留着过期的 scheduled_at 会让界面显示混乱
      scheduled_at: null,
    });
    console.log(
      `[Scheduler] ○ 循环结束(${decision.reason ?? 'unknown'}): ${task.title} 共 ${decision.runsDone} 轮`
    );
    emitBoardEvent('task_updated', { task: getTask(taskId), reason: 'repeat_exhausted' });
    return {
      rescheduled: false,
      exhausted: true,
      reason: decision.reason,
      nextAt: null,
      runsDone: decision.runsDone,
    };
  }

  const nextIso = decision.nextAt!.toISOString();
  updateTask(taskId, {
    status: 'scheduled',
    scheduled_at: nextIso,
    repeat_count: decision.runsDone,
    repeat_last_at: finishedAt,
  });
  console.log(
    `[Scheduler] ↻ 循环排下一轮: ${task.title}（${describeTaskRepeat(task)}）→ ${nextIso}`
  );
  emitBoardEvent('task_updated', { task: getTask(taskId), reason: 'repeat_scheduled' });
  return {
    rescheduled: true,
    exhausted: false,
    nextAt: nextIso,
    runsDone: decision.runsDone,
  };
}

/**
 * 恢复一个暂停中的循环任务：把过期的 `scheduled_at` 重算到下一个未来时刻。
 *
 * 为什么不能只把 `repeat_paused` 置 0 就完事：暂停期间 `scheduled_at` 可能早已过去，
 * 直接恢复会让它在下一次 tick **立刻补跑一次**（用户暂停了三天，恢复瞬间跑一轮，
 * 体感是"我没让它现在跑"）。所以恢复时显式往后排。
 *
 * @returns 重算后的时间（ISO）；配置无效或无法计算时返回 null（此时任务会被收尾交人工处理）
 */
export function resumeRepeatSchedule(taskId: string, now: Date = new Date()): string | null {
  const task = getTask(taskId);
  if (!task || normalizeRepeatMode(task.repeat_mode) === 'none') return null;

  const spec = specFromTask(task);
  if (!spec) return null;

  const until = task.repeat_until ? new Date(task.repeat_until) : null;
  const untilValid = until && !Number.isNaN(until.getTime()) ? until : null;
  const next = computeNextRun(spec, now, untilValid);
  if (!next) return null;

  const nextIso = next.toISOString();
  updateTask(taskId, { repeat_paused: 0, scheduled_at: nextIso, status: 'scheduled' });
  emitBoardEvent('task_updated', { task: getTask(taskId), reason: 'repeat_resumed' });
  return nextIso;
}

// ============================================================
// 调度主循环
// ============================================================

/**
 * 单个调度 tick。
 * 返回本轮启动的任务 ID 列表（便于测试与观测）。
 */
export function runTick(): string[] {
  if (tickInFlight) return [];
  tickInFlight = true;
  const startedTaskIds: string[] = [];

  try {
    // ---------- 阶段 1：定时任务到点提升 ----------
    const nowIso = new Date().toISOString();
    const dueTasks = getDueScheduledTasks(nowIso);
    for (const task of dueTasks) {
      /**
       * ⚠️ 被「暂停」的循环任务**不提升**。
       *
       * 暂停的语义是「先别跑了，但别把配置弄丢」—— 所以它仍留在
       * `status='scheduled'`（停在「自动化定时」列、可随时恢复），
       * 只是 `scheduled_at` 可能已经是过去时刻（暂停期间自然流逝）。
       * 恢复时由 `/tasks/:id/repeat/pause` 重算到下一个未来时刻，
       * 因此这里忽略它不会造成"恢复后立刻补跑一堆"。
       */
      if (normalizeRepeatMode(task.repeat_mode) !== 'none' && task.repeat_paused === 1) {
        continue;
      }
      updateTask(task.id, { status: 'todo', scheduled_at: null });
      const updated = getTask(task.id);
      console.log(`[Scheduler] 定时任务到点，提升为待办: ${task.title} (${task.id})`);
      emitBoardEvent('task_updated', { task: updated, reason: 'scheduled_due' });
    }

    // ---------- 阶段 2：回收失效的 running 任务 ----------
    //
    // ⚠️ 这里**不能无脑回退为待办**。
    // 本进程重启时，宿主侧的 job 可能**仍在运行**（serve 是独立子进程，看板重启不影响它）。
    // 若直接回退，调度器会重新派发同一任务 → **两个 agent 同时改同一批文件**。
    //
    // 参照项目把这种情况叫「不确定」：连接中断 ≠ 执行已停止。
    // 我们的优势是**可以向宿主核对真实状态**，所以不靠猜：
    //   - 仍在运行   → 保留 running 占位，标记待核对（不自动重派发）
    //   - 已终结     → 按真实结果落终态
    //   - 查不到     → 同样保留 running，下一轮再说
    const allTasks = getAllTasks();
    for (const task of allTasks) {
      if (task.status !== 'in_progress') continue;
      if (runningHandles.has(task.id)) continue;

      /**
       * ⚠️ **有意挂起的任务不是孤儿，既不回退也不核对。**
       *
       * `waiting_approval`（等人工决策）、`waiting_quota`（等额度）、
       * `waiting_input`（等补充输入）、`uncertain`（结果待核对）
       * 都是「停在某处等人/等条件」，本来就**没有执行句柄**（执行器已按设计退出）。
       * 若按孤儿处理会：① 丢掉决策/等待状态 ② 被重新派发造成重复执行。
       *
       * 🔴 这正是两层状态机改造引出的回归点：旧模型里 `pending_decision`
       * 是**独立状态**，孤儿回收只看 `status==='running'` 所以碰不到它；
       * 拆层后它变成 `in_progress`，不做这层判断就会被误回收。
       */
      // 判据与 index.ts 的守卫共用 db.PARKED_RUN_STATES（唯一真源，别在本地另写一份）
      if (PARKED_RUN_STATES.includes(task.run_state as import('./db.js').TaskRunState)) continue;

      // 进程已退出 ⇒ 可安全回退到待办。
      // （原先这里还要先核对 workbuddy 任务在宿主侧的真实结果，该执行器已下线，
      //   「2026-09 · CLI 派发通道」）
      console.warn(`[Scheduler] 发现孤儿 running 任务，回退为待办: ${task.title} (${task.id})`);
      updateTask(task.id, {
        status: 'todo',
        run_state: null,
        started_at: null,
        error: '执行进程中断，已自动回退到待办',
        wait_reason: null,
      });
      const updated = getTask(task.id);
      emitBoardEvent('task_updated', { task: updated, reason: 'orphan_recovered' });
    }

    // ---------- 阶段 3：调度候选任务 ----------
    /**
     * ⚠️ 并发上限是**整机**口径，不是"看板自己的任务数"：
     * 用户明确要求「WorkBuddy 正在执行 3 个、上限 5，那看板只能再跑 2 个」。
     * 占用 = 看板 in_progress + 宿主 working（已排除看板派发出去的，见 hostOccupancy.ts）。
     */
    const occupancy = getOccupancy();
    const globalLimit = occupancy.limit;
    let globalRunning = occupancy.total;

    if (globalRunning >= globalLimit) {
      if (occupancy.hostRunning > 0) {
        console.log(
          `[Scheduler] 本轮不调度：整机占用已满（看板 ${occupancy.boardRunning} + 宿主 ${occupancy.hostRunning} = ${occupancy.total}/${globalLimit}）`
        );
      }
      // 整机槽位已满，本轮不再调度
      return startedTaskIds;
    }

    const workspaces = getAllWorkspaces();
    const wsMap = new Map<string, DbWorkspace>();
    for (const ws of workspaces) wsMap.set(ws.id, ws);

    // 候选：status = todo，按 优先级降序 → 手动排序升序 → 创建时间升序
    const candidates = getAllTasks()
      .filter(t => t.status === 'todo')
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.created_at.localeCompare(b.created_at);
      });

    for (const task of candidates) {
      // 整机槽位复查（每启动一个任务都会占用一个槽位）
      if (globalRunning >= globalLimit) break;

      // ---------- 约束 ①：依赖满足 ----------
      // 依赖真源是 task_dependencies join 表（tasks.depends_on 列已降为历史遗留）
      const deps = getDependencies(task.id);
      if (deps.length > 0) {
        const unmet: string[] = [];
        for (const depId of deps) {
          const dep = getTask(depId);
          if (!dep) { unmet.push(`${depId}(已删除)`); continue; }
          if (dep.status !== 'done') unmet.push(`${dep.title}[${dep.status}]`);
        }
        if (unmet.length > 0) {
          // 依赖未满足：跳过，不报错（下一轮还会重试）
          continue;
        }
      }

      // ---------- 约束 ④：修改范围不重叠 ----------
      //
      // 声明了范围的任务，不与「同空间内正在跑、且范围有交集」的任务并行 ——
      // 否则两个 agent 会同时改同一批文件（后写的覆盖先写的）。
      //
      // 只对**就地执行**生效：worktree 模式各写各的目录，天然不冲突。
      // **未声明范围的任务不参与判定** —— 没声明就没有承诺，不能因此拦住别人；
      // 反过来，别人也拦不住它。需要严格互斥时应显式声明范围。
      const myScopes = getScopes(task.id);
      if (task.isolation !== 'worktree' && myScopes.length > 0) {
        const siblings = getAllTasks().filter(
          t =>
            t.id !== task.id &&
            t.workspace_id === task.workspace_id &&
            t.status === 'in_progress' &&
            t.isolation !== 'worktree'
        );
        let conflict: { title: string; mine: string; theirs: string } | null = null;
        for (const sib of siblings) {
          const r = anyOverlap(myScopes, getScopes(sib.id));
          if (r.overlap && r.pair) {
            conflict = { title: sib.title, mine: r.pair[0], theirs: r.pair[1] };
            break;
          }
        }
        if (conflict) {
          console.log(
            `[Scheduler] 修改范围冲突，跳过: ${task.title} ↔ ${conflict.title}` +
              `（${conflict.mine} / ${conflict.theirs}）`
          );
          continue;
        }
      }

      // ---------- 约束 ②：工作空间互锁 ----------
      //
      // 只对**就地执行**（isolation='shared'）的任务生效。
      // 独立工作树（isolation='worktree'）的任务各自在单独目录里改，
      // 与同空间其他任务并不冲突，因此不占用该空间的名额 —— 这正是「真并行」的来源。
      // 全局槽位（约束 ③）仍然对它们生效，不会失控。
      if (task.workspace_id) {
        const ws = wsMap.get(task.workspace_id);
        if (!ws) {
          // 工作空间被删除了 —— 任务无法确定执行目录
          updateTask(task.id, {
            status: 'failed',
            run_state: null,
            error: '所属工作空间已被删除，无法执行',
            finished_at: new Date().toISOString(),
          });
          emitBoardEvent('task_updated', { task: getTask(task.id), reason: 'workspace_missing' });
          continue;
        }

        // 独立工作树（isolation='worktree'）此前**只有** workbuddy 执行器实现过，
        // 该执行器已下线⇒ 现在没有任何执行器会创建独立目录，
        // 因此一律走工作空间互锁，避免「放开了互锁但没隔离」的并发写风险。
        const wsRunning = countTasksInWorkspace(ws.id, ['in_progress'], 'shared');
        if (wsRunning >= ws.max_concurrency) {
          console.log(
            `[Scheduler] 工作空间互锁，跳过: ${task.title} ` +
            `(空间「${ws.name}」运行中 ${wsRunning}/${ws.max_concurrency})`
          );
          continue;
        }
      }

      // ---------- 三重约束全部通过 → 启动 ----------
      startTask(task);
      startedTaskIds.push(task.id);
      globalRunning += 1;
    }
  } catch (err) {
    console.error('[Scheduler] tick 异常:', err);
  } finally {
    tickInFlight = false;
  }

  return startedTaskIds;
}

// ============================================================
// 任务启动
// ============================================================

function startTask(task: DbTask): void {
  const startedAt = new Date().toISOString();

  // 先落库为进行中，再启动执行器（避免竞态：同 tick 内被重复选中）
  updateTask(task.id, {
    status: 'in_progress',
    run_state: 'starting',
    started_at: startedAt,
    finished_at: null,
    error: null,
    progress_log: null,
  });

  // 开一条执行历史。后续 run_state 变化与终态收尾由 updateTask 自动同步，
  // 这里只保证「每次执行都新开一条 run」—— 重试因此不会覆盖上一次的记录。
  createTaskRun({ taskId: task.id, runState: 'starting' });

  const runningTask = getTask(task.id);

  const workspace = task.workspace_id ? getWorkspace(task.workspace_id) : undefined;
  const cwd = workspace?.path;
  const wsName = workspace?.name ?? '（无工作空间）';

  console.log(
    `[Scheduler] ▶ 启动任务: ${task.title} | 空间=${wsName} | 模型=${task.model} | 执行者=${task.executor}`
  );

  emitBoardEvent('task_started', {
    task: runningTask,
    workspaceName: wsName,
  });

  // 只有本地执行器一条路径了（workbuddy 执行器已下线）
  if (isSdkKnownUnavailable()) {
    // 本机 Agent SDK 不可用（CLI 非交互模式挂起）→ 立即失败并给出可行动提示，
    // 不要白等一个 60s 的超时周期。详见 server/sdkStatus.ts
    const reason = getSdkStatus().reason ?? '未知原因';
    console.warn(`[Scheduler] ✕ local 执行器不可用，任务快速失败: ${task.title}`);
    updateTask(task.id, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: `本地执行器不可用：${reason}。请修复本机 Agent SDK 环境后重试。`,
      progress_log: appendLog(task.progress_log, {
        kind: 'error',
        text: `本地执行器不可用：${reason}`,
      }),
    });
    emitBoardEvent('task_finished', { task: getTask(task.id) });
  } else {
    startTaskViaLocalSdk(runningTask!, cwd);
  }
}

/**
 * 路径 B：看板自带 SDK 执行（原实现，保持行为不变）。
 */
function startTaskViaLocalSdk(task: DbTask, cwd: string | undefined): void {
  const handle = runTaskAgent({
    task,
    cwd,
    onProgress: (patch) => {
      // 执行过程中的增量更新（日志、sdk_session_id 等）
      updateTask(task.id, patch);
      emitBoardEvent('task_progress', { task: getTask(task.id), patch });
    },
    onFinish: (patch) => {
      runningHandles.delete(task.id);
      // 执行结束 ⇒ 撤掉「运行中追加指令」的句柄（否则会残留一个已死的 Query）
      clearLiveQuery(task.id);
      const finishedAt = new Date().toISOString();
      updateTask(task.id, { ...patch, finished_at: finishedAt });
      /**
       * 循环任务：本轮结束后排下一轮（或按 次数上限 / 有效期 收尾）。
       *
       * ⚠️ 必须在**终态写入之后**做。终态那一步才会关闭 task_runs 里这条 run
       *    （`updateTask` 只在进入终态时补 `finished_at`）；若顺序反了，
       *    这条 run 会永远挂着 `finished_at=NULL`，执行历史里出现"永不完结的一次执行"。
       */
      const after = getTask(task.id);
      if (after && normalizeRepeatMode(after.repeat_mode) !== 'none') {
        rescheduleRepeatAfterRun(task.id, new Date(finishedAt));
      }
      const finalTask = getTask(task.id);
      console.log(
        `[Scheduler] ■ 任务结束: ${task.title} → ${finalTask?.status}`
      );
      emitBoardEvent('task_finished', { task: finalTask });
    },
    onDecisionRequired: (patch) => {
      /**
       * ⚠️ 2026-09-15 起**不再释放执行句柄** —— 决策改为 `canUseTool` 内的长轮询，
       * 挂起期间执行器是**活着的**（只是在等人），任务保持 `in_progress` ⇒
       * 工作空间锁保持（挂起期间不会有别的任务来写同一目录）。
       *
       * 旧实现会在这里 `runningHandles.delete`：那是"中止 + 退出执行器"模型的产物，
       * 现在若继续删掉句柄，`/decide` 就再也找不到挂起的 Promise ⇒ 答复无效。
       */

      // 决策进 interactions 表。requestId 含问题摘要 → 同一个问题只建一条（幂等）。
      const prompt =
        typeof patch.decision_prompt === 'string' && patch.decision_prompt
          ? patch.decision_prompt
          : '需要人工决策';
      let options: string[] = [];
      try {
        const parsed = patch.decision_options ? JSON.parse(patch.decision_options) : [];
        if (Array.isArray(parsed)) options = parsed.filter((o: unknown) => typeof o === 'string');
      } catch {
        options = [];
      }
      createInteraction({
        taskId: task.id,
        kind: 'decision',
        requestId: `local:${task.id}:${shortHash(prompt)}`,
        payload: { prompt, options },
      });

      // 其余补丁（status / run_state / result / progress_log）照常落库，
      // 但**不再写 decision_* 两个列** —— 它们已由 interactions 派生。
      const rest: Record<string, unknown> = { ...patch };
      delete rest.decision_prompt;
      delete rest.decision_options;
      updateTask(task.id, rest);

      const decided = getTask(task.id);
      console.log(`[Scheduler] ⏸ 任务待决策: ${task.title}`);
      emitBoardEvent('task_decision_required', { task: decided });
    },
  });

  runningHandles.set(task.id, handle);
}

/**
 * 读取任务的决策上下文（问题 + 最近答复）。
 *
 * ⚠️ 真源是 `interactions` 表，不是 tasks 上的 `decision_*` 列
 * （那三列是历史遗留，仅作迁移来源，不再读写）。
 */
function loadDecisionContext(taskId: string): { question: string | null; answer: string | null } {
  const pending = getPendingInteraction(taskId);
  const resolved = getLatestResolvedInteraction(taskId);
  return {
    question:
      (pending ? parseInteractionPayloadSafe(pending)?.prompt : null) ??
      (resolved ? parseInteractionPayloadSafe(resolved)?.prompt : null) ??
      null,
    answer: resolved ? parseInteractionAnswer(resolved) : null,
  };
}

function parseInteractionPayloadSafe(i: Parameters<typeof parseInteractionAnswer>[0]) {
  try {
    const parsed = JSON.parse(i.payload);
    return {
      prompt: typeof parsed?.prompt === 'string' ? parsed.prompt : '',
      options: Array.isArray(parsed?.options) ? parsed.options : [],
    };
  } catch {
    return null;
  }
}

/** 构造派发给 WorkBuddy 的 prompt（把人工决策答案拼接进去） */
function buildDispatchPrompt(task: DbTask): string {
  let prompt = task.prompt;
  const { question, answer } = loadDecisionContext(task.id);
  if (answer) {
    prompt +=
      `\n\n---\n[人工决策补充] 针对上一轮的问题「${question ?? ''}」，` +
      `决策结果如下：\n${answer}\n请据此继续完成任务。`;
  }
  return prompt;
}

/** 往进度日志追加一条（与 taskRunner 同格式），返回新的 JSON 字符串 */
export function appendLog(
  currentLog: string | null,
  entry: { kind: 'text' | 'tool' | 'tool_result' | 'system' | 'error'; text: string; toolName?: string; status?: string }
): string {
  const MAX = 200;
  let entries: any[] = [];
  if (currentLog) {
    try {
      const parsed = JSON.parse(currentLog);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = [];
    }
  }
  entries.push({ at: new Date().toISOString(), ...entry });
  if (entries.length > MAX) entries = entries.slice(entries.length - MAX);
  return JSON.stringify(entries);
}

// ============================================================
// 启动 / 停止
// ============================================================

export function startScheduler(): void {
  if (tickTimer) {
    console.log('[Scheduler] 调度器已在运行中');
    return;
  }
  console.log(
    `[Scheduler] 调度器启动 | tick=${TICK_INTERVAL_MS}ms | 全局并发上限=${getGlobalConcurrency()}`
  );
  reclaimStaleApprovals();
  ensureDefaultWorkspace();
  tickTimer = setInterval(() => {
    runTick();
  }, TICK_INTERVAL_MS);
  // 立即跑一轮，不必等首个 tick
  runTick();
}

/**
 * 启动时回收「过期的待决策」任务。
 *
 * 为什么必须做（2026-09-15 长轮询改造的配套）：
 *   决策改为 `canUseTool` **就地挂起**后，等待期间**执行器是活着的** ——
 *   Promise 挂在进程内存里。服务一重启这些 Promise 全部消失，
 *   而任务仍停在 `in_progress + run_state='waiting_approval'`；
 *   偏偏这个状态属于 `PARKED_RUN_STATES`，会被孤儿回收**明确跳过**（设计如此），
 *   ⇒ 结果就是永久卡死、谁也答不了。
 *
 * 处置：回退到待办（带上可读原因），并把待处理交互作废。
 */
function reclaimStaleApprovals(): void {
  const stale = getAllTasks().filter(
    t => t.status === 'in_progress' && t.run_state === 'waiting_approval'
  );
  if (stale.length === 0) return;
  for (const task of stale) {
    const canceled = cancelPendingInteractions(task.id);
    updateTask(task.id, {
      status: 'todo',
      run_state: null,
      wait_reason: null,
      started_at: null,
      error: '服务重启，等待中的授权已失效，请重新提交',
    });
    // 解除可能存在的挂起（正常情况下重启后为空，防御性调用）
    cancelTaskApproval(task.id, '服务重启');
    console.log(
      `[Scheduler] 回收过期待决策任务: ${task.title} (${task.id})，作废 ${canceled} 条交互`
    );
  }
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log('[Scheduler] 调度器已停止');
  }
}

/** 首次启动时若一个工作空间都没有，创建一个默认的（指向当前项目根目录） */
function ensureDefaultWorkspace(): void {
  const existing = getAllWorkspaces();
  if (existing.length > 0) return;
  const now = new Date().toISOString();
  createWorkspace({
    id: uuidv4(),
    name: '默认工作空间',
    path: process.cwd(),
    max_concurrency: 1,
    description: '系统自动创建，指向当前工作目录',
    color: '#00e5ff',
    created_at: now,
  });
  console.log(`[Scheduler] 已创建默认工作空间: ${process.cwd()}`);
}

export { TICK_INTERVAL_MS };
