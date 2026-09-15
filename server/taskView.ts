/**
 * 任务的「对外视图」序列化（唯一实现）
 * ============================================================================
 * 为什么必须集中在一处（2026-09-14 血的教训）：
 *
 *   `tasks` 表的 `progress_log` / `scopes` / `depends_on` / `decision_options`
 *   在库里是 **JSON 字符串**（历史遗留形态）。前端把它们当数组用
 *   （`progress_log.slice(-3).map(...)`、`depends_on.map(...)`），
 *   一旦把**原始行**发过去，就会 `f.map is not a function` ——
 *   而且是在渲染期抛，**整个看板被 ErrorBoundary 兜成"界面渲染出错"**。
 *
 *   实际情况：`server/index.ts` 的 REST 接口都走了 `serializeTask`，
 *   但 `server/scheduler.ts` 自己有一套 `emitBoardEvent`，直接把
 *   `getTask(id)` 的**原始行**塞进 SSE 事件 → 调度器一开始派发任务，
 *   看板就白屏。这个 bug 一直潜伏到"待办列真的有任务被调度"才暴露。
 *
 *   所以：**序列化只有这一个实现**，scheduler 的事件发射也强制过它
 *   （见 `scheduler.ts` 的 `emitBoardEvent`），从结构上杜绝再次漏掉。
 *
 * ⚠️ 本模块的函数必须**幂等**：允许对已经序列化过的对象再跑一次
 * （事件发射处无法保证拿到的到底是原始行还是已序列化对象）。
 */

import * as db from './db.js';
import { describeTaskRepeat } from './repeat.js';

/** 执行日志条目 */
export interface ProgressEntry {
  at: string;
  kind: 'text' | 'tool' | 'tool_result' | 'system' | 'error';
  text: string;
  toolName?: string;
  status?: 'running' | 'success' | 'error';
}

/**
 * 解析 JSON 数组列。
 * 已是数组则原样返回 —— 这是让序列化可重复调用的关键：
 * 对已序列化对象再跑一次不能把数组弄丢。
 */
export function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 解析执行日志列（同上：数组原样返回） */
export function parseProgressLog(raw: unknown): ProgressEntry[] {
  if (Array.isArray(raw)) return raw as ProgressEntry[];
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProgressEntry[]) : [];
  } catch {
    return [];
  }
}

/** 判断一个对象看起来是否已经序列化过（用于跳过重复的派生查询） */
function alreadySerialized(task: Record<string, unknown>): boolean {
  return Array.isArray(task.progress_log) && Array.isArray(task.depends_on);
}

/**
 * 把任务（原始行或已序列化对象）转成前端消费的形态。
 *
 * 派生字段说明：
 *   - `depends_on`      ← task_dependencies join 表（tasks.depends_on 列已降为遗留）
 *   - `decision_*`      ← interactions 表（tasks 上的同名列是迁移来源，读取时不看）
 *   - `scopes` / `progress_log` ← JSON 列解析成数组
 */
export function serializeTask(
  task: db.DbTask | null | undefined
): Record<string, unknown> | null {
  // 原始行可能是 undefined（`getTask()` 返回 `DbTask | undefined`）——
  // 直接透传 null，让前端 `if (payload.task)` 跳过，而不是在这里抛异常炸掉事件循环
  if (!task || !(task as { id?: string }).id) return null;

  const raw = task as unknown as Record<string, unknown>;
  const ws = task.workspace_id ? db.getWorkspace(task.workspace_id) : undefined;

  // 已序列化过的对象不必再查一次派生表（幂等 + 省一次 SQL）
  const skipDerived = alreadySerialized(raw);
  const pending = skipDerived ? null : db.getPendingInteraction(task.id);
  const pendingPayload = pending ? db.parseInteractionPayload(pending) : null;
  const lastResolved = skipDerived ? null : db.getLatestResolvedInteraction(task.id);
  const lastAnswer = lastResolved ? db.parseInteractionAnswer(lastResolved) : null;

  return {
    ...raw,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : db.getDependencies(task.id),
    scopes: parseJsonArray(raw.scopes),
    decision_prompt: pendingPayload?.prompt ?? (raw.decision_prompt ?? null),
    decision_options:
      pendingPayload?.options ?? (Array.isArray(raw.decision_options) ? raw.decision_options : []),
    decision_answer: lastAnswer ?? (raw.decision_answer ?? null),
    progress_log: parseProgressLog(raw.progress_log),
    workspace: ws ? { id: ws.id, name: ws.name, path: ws.path, color: ws.color } : null,
    /**
     * 定期循环：`repeat_spec` 在库里是 JSON 字符串，前端要按对象用（抽屉里的表单），
     * 直传字符串会让前端多写一遍解析+容错 —— 与 progress_log / scopes 同样的处理。
     * `repeat_desc` 是**服务端算好的人话描述**（"每天 08:20"），卡片与抽屉共用同一口径，
     * 避免两处各写一套格式化导致文案不一致。
     */
    repeat_spec: parseRepeatSpecField(raw.repeat_spec),
    repeat_desc: describeTaskRepeat({
      repeat_mode: (raw.repeat_mode as string) ?? 'none',
      repeat_spec: typeof raw.repeat_spec === 'string' ? raw.repeat_spec : null,
      repeat_until: (raw.repeat_until as string) ?? null,
      repeat_limit: (raw.repeat_limit as number) ?? null,
      repeat_count: (raw.repeat_count as number) ?? 0,
    }),
  };
}

/**
 * 解析循环规格列。已是对象则原样返回（保证本模块**幂等**，见文件顶部说明）。
 * 坏数据返回 null —— 前端据此显示"规则无效"，而不是崩掉。
 */
function parseRepeatSpecField(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
