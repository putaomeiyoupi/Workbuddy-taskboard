/**
 * 类型定义
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface Model {
  modelId: string;
  name: string;
  description?: string;
  /** 是否算「常用」（下拉默认只列这些，避免几十项淹没选择） */
  recommended?: boolean;
  vendor?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
}

/**
 * 内容块类型 - 支持文字和工具调用按顺序排列
 */
export type ContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolCall: ToolCall };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;  // 保留用于兼容，存储纯文本摘要
  model?: string;
  timestamp: Date;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];  // 保留用于兼容
  contentBlocks?: ContentBlock[];  // 新增：按顺序排列的内容块
}

export interface Session {
  id: string;
  title: string;
  model: string;
  agentId?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  createdAt: Date;
  messages: Message[];
}

export interface CustomAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  icon?: string;
  color?: string;
  permissionMode?: PermissionMode;
  createdAt: Date;
  updatedAt: Date;
}

// Agent 是 CustomAgent 的别名
export type Agent = CustomAgent;

export type Theme = 'light' | 'dark';

/**
 * 权限请求 - 用于工具调用确认
 */
export interface PermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

/**
 * 权限响应
 */
export interface PermissionResponse {
  requestId: string;
  behavior: 'allow' | 'deny';
  message?: string;
}

/* ============================================================
 * 任务看板类型
 * ============================================================ */

/**
 * 任务**生命周期**状态 —— 回答「任务处在生命周期的哪一步」。
 * 「等授权」「等额度」这类执行细节**不在**这里，见 TaskRunState。
 */
export type TaskStatus =
  | 'todo'              // 待办
  | 'in_progress'       // 进行中（含各种等待）
  | 'scheduled'         // 自动化定时
  | 'done'              // 已完成
  | 'failed'            // 已失败
  | 'cancelled';        // 已取消

/**
 * **执行阶段** —— 仅当 `status === 'in_progress'` 时有意义，其余为 null。
 * 回答「它现在具体在干什么 / 卡在哪」。
 */
export type TaskRunState =
  | 'starting'
  | 'running'
  | 'waiting_approval'  // 等人工授权 / 决策
  | 'waiting_quota'     // 等额度（预留）
  | 'waiting_input'     // 等用户补充输入（预留）
  | 'uncertain';        // 结果不确定，保留占用待核对

/**
 * 看板主板块定义（由 status + run_state 派生，见 boardConfig 的 columnOf）。
 *
 * - `completed`（已完成）：看板终态任务（done/failed/cancelled）+
 *   **宿主未归档且已结束的会话** —— 它们此前会从看板上彻底消失，
 *   用户既看不到做过什么，也无法接着继续。
 */
export type BoardColumnKey =
  | 'todo'
  | 'running'
  | 'pending_decision'
  | 'scheduled'
  | 'completed';

/** 任务优先级 */
export type TaskPriority = 0 | 1 | 2;

/** 工作空间：任务执行目录，同时是调度互锁维度 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  /** 该工作空间内允许同时运行的任务数（默认 1，即串行） */
  max_concurrency: number;
  description: string | null;
  color: string | null;
  created_at: string;
}

/** 工作空间精简信息（内嵌在任务上） */
export interface WorkspaceBrief {
  id: string;
  name: string;
  path: string;
  color: string | null;
}

/** 任务执行日志条目 */
export interface ProgressEntry {
  at: string;
  kind: 'text' | 'tool' | 'tool_result' | 'system' | 'error';
  text: string;
  toolName?: string;
  status?: 'running' | 'success' | 'error';
}

/** 任务实体 */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  workspace_id: string | null;
  workspace: WorkspaceBrief | null;
  model: string;
  agent_id: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  scheduled_at: string | null;
  depends_on: string[];
  decision_prompt: string | null;
  decision_options: string[];
  decision_answer: string | null;
  session_id: string | null;
  sdk_session_id: string | null;
  result: string | null;
  error: string | null;
  progress_log: ProgressEntry[];
  retry_count: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** 由谁执行：workbuddy = 派发给 WorkBuddy 宿主；local = 看板自身调度 */
  executor: TaskExecutor;
  /** 派发给 WorkBuddy 后对应的宿主 session id */
  host_session_id: string | null;
  /** 宿主 job id：跟进的 `reply`、取消时的 `stop` 都要用它（不能靠 sessionId 反推） */
  host_job_id: string | null;
  /** 隔离模式：shared = 就地执行（工作空间互锁）；worktree = 独立工作树（可真并行） */
  isolation: TaskIsolation;
  /** 隔离生效时 CLI 实际创建的工作树路径 */
  worktree_path: string | null;
  /**
   * 非空 = 任务**有意保留占用**并等待核对，而不是正常执行中。
   * 典型场景：看板重启后发现宿主任务仍在运行 —— 保留占位以免重复改同一批文件。
   */
  wait_reason: string | null;
  /**
   * 声明的修改范围（仓库内相对路径）。
   * 范围重叠的任务不会并行执行；已声明范围但实际改到范围外时会被标记。
   * 空数组 = 未声明，不参与冲突判定。
   */
  scopes: string[];
  /** 执行阶段；仅 status=in_progress 时有意义，其余为 null */
  run_state: TaskRunState | null;

  // ---------- 定期循环（只作用于看板自建任务；宿主定时任务仍只读） ----------
  /** 循环模式：none = 只跑一次；periodic = 每天/每周/每月固定时刻；interval = 每 N 分钟/小时/天 */
  repeat_mode: RepeatMode;
  /** 循环规格（服务端已把 JSON 解析成对象）。mode='none' 时为 null */
  repeat_spec: RepeatSpec | null;
  /** 循环截止时间（ISO，含端点）。null = 一直循环 */
  repeat_until: string | null;
  /** 最多执行轮次。null = 不限 */
  repeat_limit: number | null;
  /** 已执行轮次 */
  repeat_count: number;
  /** 暂停开关：1 = 不再触发（仍留在「自动化定时」列，可恢复） */
  repeat_paused: number;
  /** 上一轮结束时间（ISO） */
  repeat_last_at: string | null;
  /** 服务端算好的人话描述（如「每天 08:20」「每 2 小时」）—— 卡片与抽屉共用同一口径 */
  repeat_desc?: string;
}

/** 定期循环模式 */
export type RepeatMode = 'none' | 'periodic' | 'interval';

/** 周期规格：在固定的「时刻」上重复 */
export interface PeriodicSpec {
  freq: 'daily' | 'weekly' | 'monthly';
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** freq=weekly：周几（0=周日 … 6=周六） */
  byDay?: number[];
  /** freq=monthly：几号（1-31） */
  byMonthDay?: number;
}

/** 间隔规格 */
export interface IntervalSpec {
  every: number;
  unit: 'minute' | 'hour' | 'day';
}

export type RepeatSpec = PeriodicSpec | IntervalSpec;

/**
 * 任务执行者。
 *
 * ⚠️ `'workbuddy'`（交给宿主执行）**已下线**。
 * 之所以保留在联合类型里：**历史任务数据**仍可能是它，界面需要如实展示。
 * 新任务的执行者只会是 `'local'`。
 */
export type TaskExecutor = 'workbuddy' | 'local';

/**
 * 隔离模式。
 * - `shared`  ：直接在工作空间目录里改（默认），配合工作空间互锁串行。
 * - `worktree`：由 CLI 开独立 git worktree，各任务互不干扰、可真并行。
 *   ⚠️ 需要工作空间是 git 仓库；不是仓库时 CLI 会自动降级为就地执行。
 */
export type TaskIsolation = 'shared' | 'worktree';

/** 新建任务的入参 */
export interface NewTaskPayload {
  title: string;
  prompt: string;
  workspace_id: string | null;
  model: string;
  agent_id?: string | null;
  priority: TaskPriority;
  scheduled_at: string | null;
  depends_on: string[];
  /** 执行者，默认 workbuddy */
  executor?: TaskExecutor;
  /** 隔离模式，默认 shared */
  isolation?: TaskIsolation;
  /** 声明的修改范围（仓库内相对路径），留空表示不声明 */
  scopes?: string[];
  // ---------- 定期循环 ----------
  /** 循环模式，默认 'none'（只跑一次） */
  repeat_mode?: RepeatMode;
  /** 循环规格。`mode='periodic'|'interval'` 时必填，形状见 `RepeatSpec` */
  repeat_spec?: RepeatSpec | null;
  /** 循环截止时间（ISO 字符串）。留空 = 一直循环 */
  repeat_until?: string | null;
  /** 最多执行轮次。留空 = 不限 */
  repeat_limit?: number | null;
}

// ============= WorkBuddy 宿主数据（只读镜像） =============

/** 宿主工作空间 */
export interface HostWorkspace {
  path: string;
  last_opened_at: number;
}

/** 宿主会话（一次执行中的任务） */
export interface HostSession {
  id: string;
  cwd: string;
  title: string | null;
  status: string;
  model: string | null;
  source_mode: string | null;
  is_background_automation: number | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number | null;
  /** 疑似僵尸：状态 working 但长时间无活动 */
  isStale?: boolean;
  /** 距最近一次活动的毫秒数 */
  idleMs?: number;
}

/** 宿主的定时自动化 */
export interface HostAutomation {
  id: string;
  name: string;
  prompt: string;
  status: string;
  schedule_type: string;
  rrule: string | null;
  scheduled_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  next_run_at: number | null;
  /**
   * 「上次执行」时间（后端已从 `automation_runtime_state` 取值回填）。
   * ⚠️ 宿主 `automations.last_run_at` 本机恒为 null，别在前端直接用它判"从未执行"。
   */
  last_run_at: number | null;
  cwds: string[];
  model_id: string | null;
  created_at: number;
  updated_at: number;
  /** 是否正在执行（`automation_runtime_state.running`） */
  is_running: boolean;
  /** 本次运行开始时间（仅 is_running 时有值） */
  running_started_at: number | null;
  /** 本次运行的会话 id（仅 is_running 时有值） */
  running_conversation_id: string | null;
}

/** 宿主自动化的运行记录 */
export interface HostAutomationRun {
  thread_id: string;
  automation_id: string;
  status: string;
  thread_title: string | null;
  source_cwd: string | null;
  result_success: number | null;
  created_at: number;
  updated_at: number;
}

/** 宿主数据快照 */
export interface HostSnapshot {
  available: boolean;
  hostDir: string;
  error?: string;
  workspaces: HostWorkspace[];
  workingSessions: HostSession[];
  /**
   * 正在等用户回应的会话（宿主 `status = 'pending'`，桌面端显示为「待确认」）
   * —— 归入看板「待决策」列。
   */
  awaitingSessions: HostSession[];
  /**
   * 已结束但**未归档**的会话（completed）—— 可继续交代新任务。
   * ⚠️ 已排除自动化定时任务的运行（那是「自动化定时」列的内容）。
   * ⚠️ 也**不含 error**：出错会话归「待办」列，见 errorSessions。
   */
  finishedSessions: HostSession[];
  /**
   * 出错结束的会话（status=error）→ 看板「待办」列，带特别标志。
   * 用户明确：这类**不进入调度**（不自动跑、点「调度」按钮也不管它），
   * 只能点开卡片、在抽屉里手动「继续」触发。
   */
  errorSessions: HostSession[];
  recentSessions: HostSession[];
  automations: HostAutomation[];
  latestRuns: Record<string, HostAutomationRun>;
  stats: {
    workspaces: number;
    sessionsTotal: number;
    sessionsWorking: number;
    /** 正在等用户回应的会话数 */
    sessionsAwaiting: number;
    /** 未归档、非运行中、且非自动化运行的会话总数（非展示用截断值） */
    sessionsFinished: number;
    /** 出错结束的会话数 */
    sessionsErrored: number;
    automationsActive: number;
  };
  fetchedAt: string;
}

// ⚠️ 2026-09-15：原先这里还有 CLI 桥接层的三个类型（`CliBridgeStatus` / `CliJob` /
// `CliDispatchContext`）。CLI 派发通道已下线，全库已无引用 ⇒ 一并移除。
// 需要时从 内部归档 里可恢复对应形状。

/** 全局设置 */
export interface AppSettings {
  /** 跨工作空间的全局并发上限 */
  global_concurrency: number;
  [key: string]: string | number | undefined;
}

/** 实际并发占用：看板 + 宿主，合计才是「现在有几件事在跑」 */
export interface SchedulerOccupancy {
  /** 看板调度器占用的槽位 */
  boardRunning: number;
  /** 宿主正在执行、且不是看板派发出去的会话数 */
  hostRunning: number;
  /** boardRunning + hostRunning */
  total: number;
  /** 全局并发上限（只约束看板派发节奏） */
  limit: number;
}

/** 调度器运行状态 */
export interface SchedulerStatus {
  running: boolean;
  tickIntervalMs: number;
  globalConcurrency: number;
  globalRunning: number;
  runningTaskIds: string[];
  byStatus: Record<string, number>;
  occupancy?: SchedulerOccupancy;
}

/** SSE 看板事件 */
export interface BoardEvent {
  type:
    | 'snapshot'
    | 'task_created'
    | 'task_updated'
    | 'task_started'
    | 'task_progress'
    | 'task_finished'
    | 'task_decision_required'
    | 'task_deleted'
    | 'host_snapshot';
  payload: Record<string, any>;
  /**
   * 服务端给 `host_snapshot` 配的内容指纹。
   * 前端据此判重：相同 ⇒ 内容没变 ⇒ **不要 setHost**（否则每 3 秒白重渲染一整棵宿主卡片树）。
   * 详见 `server/index.ts` 的 `hostSnapshotHash`。
   */
  hash?: string;
  at: string;
}
