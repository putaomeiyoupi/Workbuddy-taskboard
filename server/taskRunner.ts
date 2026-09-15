/**
 * 任务执行器
 * ============================================================
 * 把一条看板任务交给 CodeBuddy Agent SDK 执行，并把执行过程中的
 * 文本 / 工具调用写回数据库（挂在任务关联的 session 上），
 * 同时通过 onProgress 回调驱动看板实时刷新。
 *
 * 关键设计：
 *  - 执行日志写入 tasks.progress_log（JSON 数组，保留最近 N 条），
 *    前端卡片与详情抽屉直接消费，无需轮询 messages 表
 *  - canUseTool 命中危险工具时触发「待决策」：中止本轮执行，
 *    把提问与选项落库，等待用户输入后由 resumeTask() 续跑
 *  - 支持 sdk_session_id resume，决策续跑时保留完整上下文
 */

import { query, type CanUseTool, type PermissionResult, type Query, type UserMessage } from '@tencent-ai/agent-sdk';
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import type { DbTask } from './db.js';
import { isPermissionGrant } from './permission.js';
import { NODE_EXE } from './runtime.js';
import * as authSetup from './authSetup.js';

/**
 * 过滤掉历史上的占位模型名。
 *
 * 看板早期把默认模型硬编码成 `claude-sonnet-4`，那是占位符，
 * WorkBuddy 侧并不存在 —— 拿它执行会得到
 * `400 model [claude-sonnet-4] service info not found`。
 * 这里返回 undefined 表示「不传 --model」，交给 CLI 用默认模型。
 */
function resolveSdkModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.trim();
  if (!m) return undefined;
  if (/^claude-/i.test(m)) return undefined; // 通用别名一律不是本侧注册 ID
  return m;
}

/**
 * 「等人工授权」的长轮询注册表
 * ============================================================
 * 2026-09-15 架构改造：决策**不再「中止 → 回待办 → 重跑」**，而是让 `canUseTool`
 * 返回的 Promise **挂住不 resolve**，等用户在抽屉里答复后就地 resolve ⇒ **agent 原地继续**。
 *
 * 好处（对照旧实现）：
 *  - 不再重跑 ⇒ 不浪费已完成的工具调用、不依赖 `resume` 续上下文
 *  - 任务不离开 `in_progress`（只在 `run_state` 上切换）⇒ **工作空间锁保持**，
 *    不会出现"任务挂起期间另一个任务写同一目录"
 *  - 答复可以**逆向喂回 agent**：拒绝时把用户的话当 deny 的 message，agent 能读到并改做法
 *
 * ⚠️ 与旧实现的关键差别：挂起时**执行器是活着的**（不是"已退出"）。因此
 *    服务重启后残留的 parked 任务一定是过期的 —— 需要启动时回收（见 scheduler）。
 */
interface PendingApproval {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  toolName: string;
}
const pendingApprovals = new Map<string, PendingApproval>();

/** 用户答复了某任务的授权请求 ⇒ 解除挂起（由 `POST /tasks/:id/decide` 调用） */
export function resolveTaskApproval(taskId: string, answer: string): boolean {
  const pending = pendingApprovals.get(taskId);
  if (!pending) return false;
  pendingApprovals.delete(taskId);
  pending.resolve(answer);
  return true;
}

/** 取消/删除任务时解除挂起（让 canUseTool 立即 deny，避免 Promise 悬挂） */
export function cancelTaskApproval(taskId: string, reason = '任务已取消或删除'): boolean {
  const pending = pendingApprovals.get(taskId);
  if (!pending) return false;
  pendingApprovals.delete(taskId);
  pending.reject(new Error(reason));
  return true;
}

/** 该任务当前是否在等人工授权（供取消/删除路径判断） */
export function hasPendingApproval(taskId: string): boolean {
  return pendingApprovals.has(taskId);
}

/**
 * 「本任务内始终允许」的标准文案 —— **前后端与判定共用一份**。
 *
 * ⚠️ 必须**以「允许」开头**：`isPermissionGrant()` 是前缀匹配
 *    （`/^(授权|允许|批准|同意)/`）。踩过的坑：写成「本任务内始终允许」时以「本」开头，
 *    被判定成"未授权" ⇒ 用户点了始终允许却收到 deny。
 */
const ALWAYS_ALLOW_TEXT = '允许（本任务内始终允许）';

/** 该答复是否表示「本任务内始终允许」 */
function isAlwaysAllowAnswer(answer: string): boolean {
  return answer.includes('本任务内始终允许') && isPermissionGrant(answer);
}

/** 把用户答复映射成 SDK 的权限结果 */
function answerToPermissionResult(
  answer: string,
  input: Record<string, unknown>,
  suggestions: unknown[],
): PermissionResult {
  const a = answer.trim();

  // 终止：deny + interrupt，让 SDK 直接收尾
  if (/^(终止|停止|取消|结束)/.test(a)) {
    return { behavior: 'deny', message: '用户终止了本次执行', interrupt: true } as PermissionResult;
  }
  // 「本任务内始终允许」：放行 + 把 SDK 建议的权限规则应用下去（destination 多为 session）
  if (isAlwaysAllowAnswer(a)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      ...(suggestions.length > 0 ? { updatedPermissions: suggestions as never } : {}),
    } as PermissionResult;
  }
  // 单纯允许：只放行这一次
  if (isPermissionGrant(a)) {
    return { behavior: 'allow', updatedInput: input };
  }
  // 其它（含「跳过…」与自由文本）：deny，并把用户的话作为 message 喂回 agent
  if (/^拒绝/.test(a)) {
    const reason = a.replace(/^拒绝[:：]?\s*/, '').trim();
    return { behavior: 'deny', message: reason ? `用户拒绝：${reason}` : '用户拒绝了该操作' } as PermissionResult;
  }
  return { behavior: 'deny', message: `用户未授权：${a}` } as PermissionResult;
}

/** 进度日志最大保留条数 */
const MAX_PROGRESS_ENTRIES = 200;

/** 单次任务执行最长时长（10 分钟） */
const TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** 任务执行日志条目 */
export interface ProgressEntry {
  at: string;
  kind: 'text' | 'tool' | 'tool_result' | 'system' | 'error';
  text: string;
  toolName?: string;
  status?: 'running' | 'success' | 'error';
}

export interface TaskRunHandle {
  taskId: string;
  abort: () => void;
  /** 运行中的 SDK 查询句柄（供「运行中追加指令」使用，见 streamFollowup） */
  query?: Query;
}

/**
 * 运行中的 SDK 查询句柄注册表 —— 支撑抽屉底部的「引导当前对话」输入框。
 *
 * ⚠️ 只对**看板自己执行的任务**有效：agent 进程是看板 spawn 的，句柄就在本进程内。
 *    WB 的会话做不到（它不在我们的进程里）。
 */
const liveQueries = new Map<string, Query>();

/** 任务结束时清掉句柄（由 scheduler 的 onFinish 调用） */
export function clearLiveQuery(taskId: string): void {
  liveQueries.delete(taskId);
}

/** 该任务当前是否可以追加指令 */
export function canStreamFollowup(taskId: string): boolean {
  return liveQueries.has(taskId);
}

/**
 * 往**正在执行**的任务里注入一条用户消息，用于引导当前对话。
 *
 * 走 SDK 原生的 `Query.streamInput()` ⇒ 运行中续写，**不需要中止重跑**，
 * 也不会丢失已完成的上下文。（`Query` 接口：`streamInput(stream: AsyncIterable<UserMessage>)`）
 */
export async function streamFollowup(
  taskId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const q = liveQueries.get(taskId);
  if (!q) return { ok: false, error: '任务当前不在运行中，无法追加指令' };
  if (!text.trim()) return { ok: false, error: '内容不能为空' };

  try {
    await q.streamInput(
      (async function* () {
        /**
         * ⚠️ 形态**刻意对齐 SDK 自己发字符串提示时的信封**（见
         * `transport/process-transport.js` 的 `sendUserMessage`）：
         *   `{ type:'user', session_id:'', message:{role:'user',content}, parent_tool_use_id:null }`
         *
         * 实测过的两个可疑点，都已去掉：
         *  · `isSynthetic: true` —— 语义是"合成的系统注入"，可能被 CLI 排除在会话历史之外
         *  · 带真实 `session_id` —— SDK 自己那条路径用的是**空串**，由 CLI 自行解析会话
         */
        const msg: UserMessage = {
          type: 'user',
          session_id: '',
          message: { role: 'user', content: text.trim() },
          parent_tool_use_id: null,
        };
        yield msg;
      })(),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

interface RunTaskAgentOptions {
  task: DbTask;
  cwd?: string;
  /** 执行过程中的增量更新 */
  onProgress: (patch: Partial<db.TaskUpdatableFields>) => void;
  /** 正常/异常结束 */
  onFinish: (patch: Partial<db.TaskUpdatableFields>) => void;
  /** 需要人工决策 */
  onDecisionRequired: (patch: Partial<db.TaskUpdatableFields>) => void;
}

/**
 * 判断某个工具调用是否需要转为「待决策」。
 * 策略：写文件、删除、执行命令、网络请求等高影响操作需要人工确认。
 */
const DECISION_TRIGGER_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Delete',
  'Move',
  /**
   * 🔴 `AskUserQuestion` —— **agent 主动向人提问**（不是危险操作，但同样必须人工介入）。
   *
   * 2026-09-15 修（用户报「任务一直卡住」）：此前清单里**没有**它，于是：
   *   agent 调用 AskUserQuestion → 看板不拦截 ⇒ 不进「待决策」
   *   → SDK 侧**一直等在工具返回**上（既没有结果、也没有超时）
   *   → 任务卡在 `in_progress/starting`，日志只剩「[AskUserQuestion] 调用 AskUserQuestion」。
   * 拦截后它会走与 Write/Edit 相同的闭环：转「待决策」→ 用户在抽屉选一项
   * → 回待办重跑（答复经 `buildEffectivePrompt` 以「[人工决策补充]」注入，agent 据此继续）。
   */
  'AskUserQuestion',
  /**
   * `ExitPlanMode` —— 「计划模式」下 agent 请求批准计划，**同样是在等人回答**。
   *
   * 防御性加入（2026-09-15）：本 SDK 的 lib 层没有它的类型，但**CLI bundle 里存在**
   * （`node_modules/@tencent-ai/agent-sdk/cli/dist/codebuddy-headless.js`），
   * 因此经 `canUseTool` 冒出来时若不拦截，就会像当初的 `AskUserQuestion` 一样**永久挂起**。
   * 看板目前不主动进计划模式，实际触发概率低 —— 但拦截成本极低，不拦则风险全担。
   */
  'ExitPlanMode',
]);

/** 危险命令模式（命中则必定转为待决策） */
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\bdel\s+\/[sfq]/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /git\s+push\s+.*--force/i,
  /git\s+reset\s+--hard/i,
  /\bshutdown\b/i,
  /\bformat\s+[a-z]:/i,
];

/** 是否是需要人工决策的工具调用 */
function needsDecision(toolName: string, input: Record<string, unknown>): boolean {
  if (!DECISION_TRIGGER_TOOLS.has(toolName)) return false;

  // agent 主动提问 / 请求批准计划：**无条件**转人工（它们本身就在等人回答，不是"危险操作"）
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return true;

  // Bash / 命令类：只在高危模式下拦截，普通只读命令直接放行
  const command =
    typeof input.command === 'string'
      ? input.command
      : typeof input.cmd === 'string'
        ? (input.cmd as string)
        : '';

  if (command) {
    return DANGEROUS_COMMAND_PATTERNS.some(p => p.test(command));
  }

  // Write / Edit 等写操作：一律需要确认
  return true;
}

/**
 * 从工具输入中提取一段人类可读的描述，用于决策卡片展示。
 *
 * ⚠️ `permOptions`（SDK 的第三个参数）里带着**更权威的原因**，别丢：
 *   · `decisionReason` —— SDK 自己为什么要求授权（如「检测到受保护文件修改」）
 *   · `blockedPath`    —— 被拦截的具体路径
 * 只从工具输入猜文案（原先的做法）会在**受保护文件**这类场景里丢失关键信息。
 */
function describeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  permOptions?: { decisionReason?: string; blockedPath?: string },
): string {
  const filePath =
    (input.file_path as string) ||
    (input.path as string) ||
    (input.notebook_path as string) ||
    '';
  const command = (input.command as string) || (input.cmd as string) || '';

  let detail: string;
  switch (toolName) {
    case 'AskUserQuestion': {
      // 形状：{ questions: [{ question, header?, options?: [{label, description?}], multiSelect? }] }
      const qs = Array.isArray((input as { questions?: unknown }).questions)
        ? ((input as { questions: Array<Record<string, unknown>> }).questions)
        : [];
      const first = qs[0] ?? {};
      const question = typeof first.question === 'string' ? first.question : '';
      const extra = qs.length > 1 ? `（共 ${qs.length} 个问题，这里先展示第 1 个）` : '';
      detail = question ? `agent 提问：${question}${extra}` : 'agent 需要你就当前情况做出选择';
      break;
    }
    case 'ExitPlanMode': {
      const plan = (input as { plan?: unknown }).plan;
      detail = typeof plan === 'string' && plan.trim()
        ? `agent 提交了执行计划，等待批准：${plan.trim().slice(0, 200)}`
        : 'agent 提交了执行计划，等待批准';
      break;
    }
    case 'Write':
      detail = `写入文件：${filePath}`;
      break;
    case 'Edit':
    case 'MultiEdit':
      detail = `修改文件：${filePath}`;
      break;
    case 'NotebookEdit':
      detail = `修改 Notebook：${filePath}`;
      break;
    case 'Bash':
      detail = `执行命令：${command}`;
      break;
    case 'Delete':
      detail = `删除：${filePath}`;
      break;
    case 'Move':
      detail = `移动：${filePath}`;
      break;
    default:
      detail = `调用工具 ${toolName}`;
  }

  // agent 主动提问 / 提交计划时不需要再叠原因（那句话本身已是全部信息）
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return detail;

  const reason = typeof permOptions?.decisionReason === 'string' ? permOptions.decisionReason.trim() : '';
  const blocked = typeof permOptions?.blockedPath === 'string' ? permOptions.blockedPath.trim() : '';
  if (reason) return `${reason}｜${detail}`;
  if (blocked && !detail.includes(blocked)) return `受保护路径 ${blocked}｜${detail}`;
  return detail;
}

/**
 * 生成决策的可选项。
 *
 * ⚠️ `AskUserQuestion` 的选项**来自工具输入本身**（agent 定义的问题选项），
 *    不能套用「允许/跳过/终止」那套 —— 那是危险操作的语气，对「二选一提问」毫无意义。
 */
function buildDecisionOptions(toolName: string, input?: Record<string, unknown>): string[] {
  if (toolName === 'ExitPlanMode') {
    return ['批准计划并继续', '先说明计划里的取舍再继续', '终止任务'];
  }
  if (toolName === 'AskUserQuestion') {
    const qs = Array.isArray(input?.questions)
      ? (input!.questions as Array<Record<string, unknown>>)
      : [];
    const first = qs[0] ?? {};
    const opts = Array.isArray(first.options)
      ? (first.options as Array<Record<string, unknown>>)
          .map(o => (typeof o.label === 'string' ? o.label : ''))
          .filter(Boolean)
      : [];
    // agent 没给选项时，给一组"通用答复"提示，用户也可自行输入
    return opts.length > 0 ? [...opts, '终止任务'] : ['继续（按你的判断处理）', '终止任务'];
  }
  if (toolName === 'Bash') {
    return ['允许执行此命令', ALWAYS_ALLOW_TEXT, '拒绝', '终止任务'];
  }
  return ['允许此次修改', ALWAYS_ALLOW_TEXT, '拒绝', '终止任务'];
}

/**
 * 取「本任务最近一次已答复的决策」（答复内容 + 当时的问题）。
 *
 * 🔴 2026-09-15 修（用户报「提交决策后没反应」）：
 *   原先两处都读 `task.decision_answer` / `task.decision_prompt`，那是 tasks 表上的
 *   **历史遗留列** —— 真源早已迁到 `interactions` 表（见 `taskView.ts` 里 `decision_*`
 *   的派生说明），而 `POST /tasks/:id/decide` **只写 interactions、不写这两列**。
 *
 *   后果一（实测复现）：`preApproved` 恒为 false ⇒ 答复后任务回待办重跑，
 *     立刻又在同一个 Write 工具处被 `canUseTool` 拦截 ⇒ 再次转「待决策」。
 *     用户视角 = 「点了『允许此次修改』→ 卡片又弹回待决策 = 点了没反应」。
 *   后果二：答复文本也注入不进 `buildEffectivePrompt` ⇒ 像「先说明你将做哪些改动」
 *     这类**非授权**选项永远不可能生效（agent 压根不知道用户选了什么）。
 *
 * ⚠️ 不要再退回读那两列；遗留列只作最后兜底（兼容老数据）。
 */
function resolveEffectiveDecision(task: DbTask): { answer: string | null; prompt: string | null } {
  try {
    // listInteractions 按 created_at 倒序 ⇒ 第一条 resolved 就是最近一次答复
    const latestResolved = db.listInteractions(task.id).find(i => i.status === 'resolved');
    if (latestResolved) {
      const answer = db.parseInteractionAnswer(latestResolved);
      if (answer) {
        return { answer, prompt: db.parseInteractionPayload(latestResolved)?.prompt ?? null };
      }
    }
  } catch {
    // 读取失败则退回遗留列（不因读表异常阻断执行）
  }
  return { answer: task.decision_answer ?? null, prompt: task.decision_prompt ?? null };
}

/** 往进度日志追加一条，并返回新的 JSON 字符串 */
function appendProgress(
  currentLog: string | null,
  entry: ProgressEntry
): { log: string; entries: ProgressEntry[] } {
  let entries: ProgressEntry[] = [];
  if (currentLog) {
    try {
      const parsed = JSON.parse(currentLog);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = [];
    }
  }
  entries.push(entry);
  if (entries.length > MAX_PROGRESS_ENTRIES) {
    entries = entries.slice(entries.length - MAX_PROGRESS_ENTRIES);
  }
  return { log: JSON.stringify(entries), entries };
}

/** 解析进度日志字符串 */
export function parseProgressLog(raw: string | null): ProgressEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 启动一条任务的 SDK 执行。
 * 立即返回句柄，执行在后台异步进行。
 */
export function runTaskAgent(options: RunTaskAgentOptions): TaskRunHandle {
  const { task, cwd, onProgress, onFinish, onDecisionRequired } = options;

  let aborted = false;
  const abortController = new AbortController();

  // 确保任务有一个关联的 session，用于保存完整对话记录
  let sessionId = task.session_id;
  if (!sessionId) {
    sessionId = uuidv4();
    const now = new Date().toISOString();
    db.createSession({
      id: sessionId,
      title: `[任务] ${task.title}`,
      model: task.model,
      sdk_session_id: null,
      created_at: now,
      updated_at: now,
    });
    onProgress({ session_id: sessionId });
  }

  // 记录用户侧 prompt 到 sessions
  db.createMessage({
    id: uuidv4(),
    session_id: sessionId,
    role: 'user',
    content: buildEffectivePrompt(task),
    model: task.model,
    created_at: new Date().toISOString(),
    tool_calls: null,
  });

  let progressLog = task.progress_log;

  const pushEntry = (entry: Omit<ProgressEntry, 'at'>) => {
    const result = appendProgress(progressLog, { at: new Date().toISOString(), ...entry });
    progressLog = result.log;
    onProgress({ progress_log: progressLog });
  };

  /**
   * 先建句柄、再跑 IIFE —— 因为 IIFE 内部要把 `query` 回填进来
   * （「运行中追加指令」需要它，见 streamFollowup）。
   */
  const handle: TaskRunHandle = {
    taskId: task.id,
    abort: () => {
      aborted = true;
      abortController.abort();
    },
  };

  // 执行主流程（异步，不阻塞调度器 tick）
  (async () => {
    let fullText = '';
    /** 「本任务内始终允许」的工具白名单（本次执行内有效） */
    const sessionAllowedTools = new Set<string>();
    /**
     * 任务级超时。⚠️ **等人工授权期间必须暂停它** —— 否则用户思考 10 分钟就把任务杀了。
     * 所以抽成可重臂的函数：授权答复后再续一轮预算。
     */
    let timeoutHandle: NodeJS.Timeout | undefined;
    const armTimeout = () => {
      timeoutHandle = setTimeout(() => {
        if (!aborted) {
          aborted = true;
          abortController.abort();
        }
      }, TASK_TIMEOUT_MS);
    };
    armTimeout();

    try {
      pushEntry({ kind: 'system', text: `任务开始执行 · 模型 ${task.model}` });

      /**
       * 兼容「授权后重跑」的旧路径（如用户手动重试）：上一轮已答复的授权直接放行。
       * ⚠️ 新版长轮询下授权**原地生效**，已不依赖它（见 `resolveEffectiveDecision` 注释）。
       */
      const effectiveAnswer = resolveEffectiveDecision(task).answer;
      const preApproved = isPermissionGrant(effectiveAnswer);
      if (preApproved) {
        pushEntry({
          kind: 'system',
          text: `已获人工授权（${effectiveAnswer}），本轮不再拦截工具调用`,
        });
      }

      const canUseTool: CanUseTool = async (toolName, input, permOptions): Promise<PermissionResult> => {
        const inputRecord = input as Record<string, unknown>;

        if (preApproved) {
          return { behavior: 'allow', updatedInput: input };
        }

        if (needsDecision(toolName, inputRecord)) {
          // 「本任务内始终允许」已记过 ⇒ 直接放行
          // （双保险：SDK 的 updatedPermissions 在部分版本/站点未必落地）
          if (sessionAllowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input };
          }

          // ⚠️ 必须把 permOptions 传进去：它带 decisionReason / blockedPath
          //    （如「检测到受保护文件修改」），只靠工具输入猜会丢关键信息
          const prompt = describeToolInput(toolName, inputRecord, permOptions);
          const options = buildDecisionOptions(toolName, inputRecord);
          const suggestions = Array.isArray(permOptions?.suggestions) ? permOptions.suggestions : [];

          pushEntry({ kind: 'system', text: `⏸ 需要人工决策：${prompt}` });

          /**
           * ① 落库 + 通知前端。
           * ⚠️ 与旧实现的差别：**保留执行句柄**（本次执行是活的，只是在等人），
           *    因此任务不离开 `in_progress`（只在 run_state 上切到 waiting_approval）
           *    ⇒ 工作空间锁保持，不会出现"挂起期间别人写同一目录"。
           */
          onDecisionRequired({
            run_state: 'waiting_approval',
            decision_prompt: prompt,
            decision_options: JSON.stringify(options),
            progress_log: progressLog,
            error: null,
          });

          // ② 挂住等答复（**不中止、不重跑** agent）；等的时候暂停任务级超时
          clearTimeout(timeoutHandle);
          let answer: string;
          try {
            answer = await new Promise<string>((resolve, reject) => {
              pendingApprovals.set(task.id, { resolve, reject, toolName });
            });
          } catch (err) {
            const msg = (err as Error)?.message ?? '授权等待被中断';
            pushEntry({ kind: 'system', text: `授权等待被中断：${msg}` });
            pendingApprovals.delete(task.id);
            armTimeout();
            onProgress({ run_state: 'running' });
            return { behavior: 'deny', message: msg } as PermissionResult;
          }
          pendingApprovals.delete(task.id);
          armTimeout();
          onProgress({ run_state: 'running' });

          if (isAlwaysAllowAnswer(answer)) {
            sessionAllowedTools.add(toolName);
          }
          pushEntry({ kind: 'system', text: `✅ 人工答复：${answer}` });
          return answerToPermissionResult(answer, inputRecord, suggestions);
        }

        return { behavior: 'allow', updatedInput: input };
      };

      const stream = query({
        prompt: buildEffectivePrompt(task),
        options: {
          cwd: cwd || process.cwd(),
          // 占位模型名会被过滤成 undefined → 不传 --model，用 CLI 默认模型。
          // 硬传 claude-sonnet-4 会得到 400 service info not found。
          model: resolveSdkModel(task.model),
          maxTurns: 30,
          permissionMode: 'default',
          canUseTool,
          // 显式指定 node 运行时（本机系统 PATH 无 node，SDK 兜底的裸 `node` 会 ENOENT）
          executable: NODE_EXE,
          /**
           * 显式传站点，取「跟随已有凭据」的当前值
           * （多站点凭据共存时避免选错；凭据域名 → 站点，其次宿主网络环境，最后兜底国内站）。
           *
           * ✅ 2026-09-15 已解决（留档，避免后人重复排查）：
           *   现象：双击 `start.cmd` 启动的看板执行任务时报
           *        `Authentication required. Please use /login command to sign in`。
           *   根因：该进程既没有 `CODEBUDDY_API_KEY`、也没有
           *        `CODEBUDDY_INTERNET_ENVIRONMENT=internal` —— 官方文档点名后者是
           *        **最常被遗漏**的配置项，漏了会「鉴权失败或连到错误的服务端点」。
           *   修复：新增 `server/loadEnv.ts` 加载项目根 `.env`（并提供 `.env.example` 模板）。
           *   实测：任务 `status=done`；宿主 `sessions` 与 `~/.workbuddy/projects/` **零新增**。
           *
           * ⚠️ 排查时曾误判为「站点不匹配」，但对照实验推翻了它 —— 别再把 environment 当元凶。
           *    详见 `.workbuddy/memory/2026-09-14.md`。
           */
          environment: authSetup.defaultEnvironment(),
          // ⚠️ 不要传 requestTimeoutMs！SDK 会把它翻译成 CLI 的
          // `--request-timeout-ms`，而 CLI 2.137.1 不认识该参数 →
          // `error: unknown option '--request-timeout-ms'` → 子进程立即退出。
          // 任务级超时由外层的 TASK_TIMEOUT_MS 兜底。
          ...(task.sdk_session_id ? { resume: task.sdk_session_id } : {}),
        },
      });

      // 暴露运行中的句柄 ⇒ 支持「运行中追加指令」（抽屉底部的输入框）
      handle.query = stream as Query;
      liveQueries.set(task.id, stream as Query);

      // 记录 assistant 消息（流式累积后落库）
      const assistantMessageId = uuidv4();
      const toolCallsAccum: Array<Record<string, unknown>> = [];
      let streamSdkSessionId: string | null = null;

      for await (const msg of stream as any) {
        if (aborted) break;

        // 会话初始化：捕获 SDK session id，支持后续 resume
        if (msg.type === 'system' && msg.subtype === 'init') {
          streamSdkSessionId = msg.session_id;
          onProgress({ sdk_session_id: streamSdkSessionId });
          continue;
        }

        if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (typeof content === 'string') {
            fullText += content;
            pushEntry({ kind: 'text', text: content });
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                fullText += block.text;
                pushEntry({ kind: 'text', text: block.text });
              } else if (block.type === 'tool_use') {
                toolCallsAccum.push({
                  id: block.id,
                  name: block.name,
                  input: block.input,
                  status: 'running',
                });
                pushEntry({
                  kind: 'tool',
                  text: describeToolCall(block.name, block.input),
                  toolName: block.name,
                  status: 'running',
                });
              }
            }
          }
          continue;
        }

        if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
          // tool_result 回传
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              const matched = toolCallsAccum.find(t => t.id === block.tool_use_id);
              const isError = block.is_error === true;
              if (matched) matched.status = isError ? 'error' : 'success';
              pushEntry({
                kind: 'tool_result',
                text: summarizeToolResult(block.content),
                toolName: (matched?.name as string) || 'tool',
                status: isError ? 'error' : 'success',
              });
            }
          }
          continue;
        }

        if (msg.type === 'result') {
          const resultText = typeof msg.result === 'string' ? msg.result : '';
          if (resultText && !fullText.trim()) {
            fullText = resultText;
          }
          break;
        }
      }

      clearTimeout(timeoutHandle);

      // 保存 assistant 消息
      db.createMessage({
        id: assistantMessageId,
        session_id: sessionId!,
        role: 'assistant',
        content: fullText || '(无文本输出)',
        model: task.model,
        created_at: new Date().toISOString(),
        tool_calls: toolCallsAccum.length > 0 ? JSON.stringify(toolCallsAccum) : null,
      });

      // ⚠️ 2026-09-15 起，决策走 canUseTool 内的**长轮询**（就地等待），
      //    不再有"中止 → 流退出 → 在这里落待决策"的分支 —— 该分支已删除。
      if (aborted) {
        pushEntry({ kind: 'system', text: '任务已被中止' });
        onFinish({
          status: 'failed',
          run_state: null,
          error: '任务超时或被中止',
          result: fullText || null,
          progress_log: progressLog,
        });
        return;
      }

      pushEntry({ kind: 'system', text: '✅ 任务执行完成' });
      onFinish({
        status: 'done',
        run_state: null,
        result: fullText || '(无文本输出)',
        progress_log: progressLog,
        error: null,
      });
    } catch (err: any) {
      clearTimeout(timeoutHandle);
      const message = err?.message || String(err);

      // ⚠️ 决策不再以"中止"形式出现（改为长轮询就地等待，见 canUseTool），
      //    因此原先这里"异常 + decisionHit ⇒ 落待决策"的分支已删除。

      // 用户主动取消 / 超时中止
      if (aborted) {
        pushEntry({ kind: 'system', text: '任务已被中止' });
        onFinish({
          status: 'failed',
          run_state: null,
          error: '任务超时或被中止',
          result: fullText || null,
          progress_log: progressLog,
        });
        return;
      }

      console.error(`[TaskRunner] 任务执行失败 (${task.id}):`, message);
      pushEntry({ kind: 'error', text: `执行失败：${message}` });
      onFinish({
        status: 'failed',
        run_state: null,
        error: describeFailure(message),
        result: fullText || null,
        progress_log: progressLog,
      });
    }
  })();

  return handle;
}

/**
 * 把 SDK 的原始报错翻译成可行动的提示。
 *
 * 本机实测：Agent SDK 初始化会撞上 CLI 的凭据保护策略（读取凭据目录需人工确认，
 * 非交互场景下无人应答），表现为 `Request timeout: initialize`。
 * 这不是看板的 bug，而是该执行器在当前环境不可用，应引导用户改用 workbuddy 执行器。
 */
function describeFailure(message: string): string {
  if (/timeout:\s*initialize|initialize.*timeout/i.test(message)) {
    return (
      'Agent SDK 无法初始化（' + message + '）。' +
      '本机 CLI 的凭据保护策略要求在读取凭据目录时人工确认，非交互场景下无法完成，' +
      '因此 local 执行器当前不可用。请把该任务的执行者改为「workbuddy」后重试。'
    );
  }
  return message;
}

/** 构造实际发给 SDK 的 prompt（把决策答案拼进去） */
function buildEffectivePrompt(task: DbTask): string {
  let prompt = task.prompt;
  // ⚠️ 走 resolveEffectiveDecision（interactions 真源），不要读遗留列 —— 否则答复进不了提示词
  const { answer, prompt: decisionPrompt } = resolveEffectiveDecision(task);
  if (answer) {
    prompt += `\n\n---\n[人工决策补充] 针对上一轮的问题「${decisionPrompt ?? ''}」，决策结果如下：\n${answer}\n请据此继续完成任务。`;
  }
  return prompt;
}

/** 把工具调用转成一行人类可读描述 */
function describeToolCall(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return `调用 ${toolName}`;
  const filePath = input.file_path || input.path || input.notebook_path || '';
  const command = input.command || input.cmd || '';
  const query = input.query || '';
  const url = input.url || '';

  const labels: Record<string, string> = {
    Read: `读取 ${filePath}`,
    Write: `写入 ${filePath}`,
    Edit: `编辑 ${filePath}`,
    MultiEdit: `批量编辑 ${filePath}`,
    Bash: `执行 ${command}`,
    Glob: `查找文件 ${input.pattern || ''}`,
    Grep: `搜索 ${input.pattern || ''}`,
    WebSearch: `联网搜索 ${query}`,
    WebFetch: `抓取 ${url}`,
    Skill: `加载技能 ${input.skill || ''}`,
    Task: `派发子任务`,
  };
  return labels[toolName] || `调用 ${toolName}`;
}

/** 把工具结果压缩成一行摘要 */
function summarizeToolResult(content: any): string {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .join('\n');
  } else if (content && typeof content === 'object') {
    text = JSON.stringify(content);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? text.slice(0, 300) + '…' : text || '(无输出)';
}
