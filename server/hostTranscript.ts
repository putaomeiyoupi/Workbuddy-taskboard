/**
 * 宿主会话的「轻量对话读取」（只读）
 * ============================================================================
 * 用途（用户报的 bug）：WorkBuddy 里的会话卡在「等你选择」时，看板只拿到
 * sessions 表的元数据（标题/状态/cwd），**看不到它在问什么、有什么选项** ——
 * 于是抽屉里空有"继续这个对话"，用户无从下手。
 *
 * 数据来源：`<宿主目录>/projects/<cwd 转成的 slug>/<sessionId>.jsonl`
 *   - 每行一个 JSON；`type` 取值实测有：message / reasoning / function_call /
 *     file-history-snapshot / ai-title …
 *   - **关键**：Agent 让用户做选择时用的是 `AskUserQuestion` 工具调用，
 *     参数里直接带问题与选项：
 *     {"questions":[{"question":"...","header":"...","options":[{"label":"...","description":"..."}]}]}
 *
 * ⚠️ 只读：本模块只 `readFileSync`，绝不写宿主目录。
 * ⚠️ 容错优先：文件不存在/解析失败/字段缺失都降级为空结果，绝不抛给调用方 ——
 *    看板的可用性不该被一段格式异常的日志拖垮。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface TailMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  at?: number;
}

/**
 * 最近活动（运行中会话的「实时执行视图」）。
 * 用户要求：点开执行中的卡片要看得到**具体在执行什么**，而不是一个用不上的"继续对话"按钮。
 */
export interface ActivityEntry {
  kind: 'text' | 'tool' | 'tool_result';
  /** 文本内容（tool 时形如 `Edit · skills/xxx.md`） */
  text: string;
  at?: number;
  /** kind=text 时区分谁说的 */
  role?: 'user' | 'assistant' | 'system';
  /** 工具结果是否失败 */
  isError?: boolean;
}

export interface SessionTranscriptLite {
  sessionId: string;
  /** 找到的 jsonl 文件（排障用） */
  file?: string;
  /** 最近一次「等用户选择」的提问；已被回答或没有则为 null */
  pending: { questions: PendingQuestion[]; toolCallId?: string } | null;
  /** 最近几条消息（用于展示上下文，已截断） */
  tail: TailMessage[];
  /** 最近活动（工具调用/输出/文本），给运行中的会话做实时视图 */
  recent: ActivityEntry[];
  /** 记录文件最后写入时间（毫秒）—— 前端据此显示"数据新鲜度" */
  updatedAt?: number;
  /**
   * 是否只展示了一部分：
   *  - `fileTooLarge`：记录文件超过读取上限（4MB），只取了尾部；
   *  - `activityCapped`：活动条数超过 `recentLimit`，只取了最近 N 条。
   * 界面上必须如实提示，**不能让用户以为看到的就是全部**。
   */
  partial?: { fileTooLarge?: boolean; activityCapped?: boolean; totalEntries?: number; shown?: number };
  error?: string;
}

/** 宿主根目录（env 优先，其次用户主目录；不写死用户名） */
function hostDir(): string {
  const fromEnv = process.env.CODEBUDDY_CONFIG_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.join(os.homedir(), '.workbuddy');
}

/** 单条消息最多留多少字（免得把整个仓库塞进抽屉） */
const MAX_TEXT = 600;
/** 「完整对话」模式下单条消息的上限（用户明确要看原文，放宽很多但仍设界防爆） */
const MAX_TEXT_FULL = 8000;
/** 尾部消息最多取几条 */
const MAX_TAIL = 6;
/** 单文件读取上限（超过就只读末尾一段，jsonl 的尾部才是最新的） */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** 在 projects/<slug>/ 下找到该会话的 jsonl */
function locateTranscript(sessionId: string): string | null {
  const base = path.join(hostDir(), 'projects');
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(base, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    /* 目录读不到就算了 */
  }
  return null;
}

/** 读取文本（大文件只读尾部，尽量对齐到行首） */
/**
 * 读取文本。大文件只读尾部（对齐到行首）并**回报是否被截断** ——
 * 「完整对话」视图必须诚实告知"这只是最近部分"，不能假装是全文。
 */
function readTranscriptText(file: string): { text: string; truncated: boolean } {
  const size = fs.statSync(file).size;
  if (size <= MAX_READ_BYTES) return { text: fs.readFileSync(file, 'utf8'), truncated: false };
  const fd = fs.openSync(file, 'r');
  try {
    const start = size - MAX_READ_BYTES;
    const buf = Buffer.alloc(MAX_READ_BYTES);
    fs.readSync(fd, buf, 0, MAX_READ_BYTES, start);
    const text = buf.toString('utf8');
    // 丢掉可能被截断的首行
    const nl = text.indexOf('\n');
    return { text: nl >= 0 ? text.slice(nl + 1) : text, truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

/** 把 message 的 content 拼成纯文本 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (!c) continue;
    const t = c.text ?? c.content ?? c.output;
    if (typeof t === 'string' && t.trim()) parts.push(t);
  }
  return parts.join('\n');
}

/** 去掉系统注入的 `<system-reminder>` 之类噪音，并按 limit 截断 */
function clean(text: string, limit: number = MAX_TEXT): string {
  return text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?user_query>/g, '')
    .replace(/<user_info[\s\S]*?<\/user_info>/g, '')
    .trim()
    .slice(0, limit);
}

/** 解析 AskUserQuestion 的参数（字符串 JSON，容错） */
function parseAskArgs(raw: unknown): PendingQuestion[] {
  let args: any = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(args?.questions) ? args.questions : [];
  const out: PendingQuestion[] = [];
  for (const q of list) {
    if (!q || typeof q.question !== 'string') continue;
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o: any) => o && typeof o.label === 'string')
            .map((o: any) => ({
              label: String(o.label),
              description: typeof o.description === 'string' ? o.description : undefined,
            }))
        : [],
    });
  }
  return out;
}

/**
 * 读取某会话的「待选择提问 + 最近对话」。
 * `includeTail` 可关掉（只想知道有没有提问时省点解析）。
 */
/** 从工具调用参数里挑出「最像主题」的那一项，做成一行摘要 */
function toolSummary(name: string, rawArgs: unknown): string {
  let args: any = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = null;
    }
  }
  const pick = (v: unknown, max = 120): string => {
    if (typeof v !== 'string') return '';
    const one = v.replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max) + '…' : one;
  };
  const bits: string[] = [];
  if (args && typeof args === 'object') {
    const cand =
      pick(args.command, 140) ||
      pick(args.file_path) ||
      pick(args.path) ||
      pick(args.pattern) ||
      pick(args.url) ||
      pick(args.query) ||
      pick(args.prompt) ||
      (() => {
        try {
          return pick(JSON.stringify(args), 100);
        } catch {
          return '';
        }
      })();
    if (cand) bits.push(cand);
  }
  return bits.length ? `${name} · ${bits[0]}` : name;
}

/** 工具结果文本 */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const t = (output as Record<string, unknown>).text ?? (output as Record<string, unknown>).content;
    if (typeof t === 'string') return t;
  }
  return '';
}

export function readSessionTranscript(
  sessionId: string,
  opts: { includeTail?: boolean; recentLimit?: number; mode?: 'lite' | 'full' } = {}
): SessionTranscriptLite {
  /**
   * `mode` 决定「单条文本留多少字」：
   *  - `lite`（默认）：抽屉里的实时活动流，够看"在干什么"就行，单条 600 字；
   *  - `full`：「查看完整对话」视图，用户明确要看原文，放宽到 8000 字。
   * 活动条数上限由调用方的 `recentLimit` 控制（route 里钳到 500）。
   */
  const { includeTail = true, recentLimit = 30, mode = 'lite' } = opts;
  const textLimit = mode === 'full' ? MAX_TEXT_FULL : MAX_TEXT;
  if (!sessionId)
    return { sessionId, pending: null, tail: [], recent: [], error: '缺少 sessionId' };

  const file = locateTranscript(sessionId);
  if (!file)
    return { sessionId, pending: null, tail: [], recent: [], error: '找不到该会话的记录文件' };

  let lines: string[] = [];
  let updatedAt: number | undefined;
  let fileTooLarge = false;
  try {
    updatedAt = fs.statSync(file).mtimeMs;
    const read = readTranscriptText(file);
    fileTooLarge = read.truncated;
    lines = read.text.split('\n');
  } catch (err: any) {
    return {
      sessionId,
      file,
      pending: null,
      tail: [],
      recent: [],
      error: `读取失败：${err?.message ?? err}`,
    };
  }

  const entries: Array<Record<string, any>> = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      entries.push(JSON.parse(l));
    } catch {
      /* 单行坏了跳过 */
    }
  }

  /**
   * 提问是否仍然「悬而未决」：取**最后一条** AskUserQuestion；
   * 它之后的任何 message / function_call_result 都说明对话已经往前走了 → 不算待回答。
   */
  let askIdx = -1;
  let askQuestions: PendingQuestion[] = [];
  /** ⭐ 那条提问的 `toolCallId`（= function_call 行的 `id`）——回答它时必须带上 */
  let askToolCallId: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'function_call' && e.name === 'AskUserQuestion') {
      const qs = parseAskArgs(e.arguments);
      if (qs.length > 0) {
        askIdx = i;
        askQuestions = qs;
        askToolCallId = typeof e.id === 'string' && e.id ? e.id : undefined;
      }
      break; // 只看最后一条 AskUserQuestion
    }
  }
  let pending: { questions: PendingQuestion[]; toolCallId?: string } | null = null;
  if (askIdx >= 0) {
    const after = entries.slice(askIdx + 1);
    const advanced = after.some(
      e => e?.type === 'message' || e?.type === 'function_call_result' || e?.type === 'tool_result'
    );
    if (!advanced) pending = { questions: askQuestions, toolCallId: askToolCallId };
  }

  const tail: TailMessage[] = [];
  if (includeTail) {
    const msgs = entries.filter(e => e?.type === 'message');
    for (const m of msgs.slice(-MAX_TAIL)) {
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system';
      const text = clean(messageText(m.content), textLimit);
      if (text) tail.push({ role, text, at: typeof m.timestamp === 'number' ? m.timestamp : undefined });
    }
  }

  /**
   * 最近活动：把「文本 / 工具调用 / 工具结果」按时序拼成一条时间线，
   * 供运行中的会话做实时视图（reasoning 与文件快照太吵，跳过）。
   */
  const recent: ActivityEntry[] = [];
  /** 活动类条目的总数（用于如实告知"只展示了最近 N / 共 M 条"） */
  let activityTotal = 0;
  if (recentLimit > 0) {
    const ACTIVITY = new Set(['message', 'function_call', 'function_call_result']);
    const allActivity = entries.filter(e => ACTIVITY.has(String(e?.type)));
    activityTotal = allActivity.length;
    const picked = allActivity.slice(-recentLimit);
    for (const e of picked) {
      const at = typeof e.timestamp === 'number' ? e.timestamp : undefined;
      if (e.type === 'message') {
        const role = e.role === 'user' ? 'user' : e.role === 'assistant' ? 'assistant' : 'system';
        // 用户消息里常带系统注入的 context，清一遍；assistant 的原文就是要看的
        const text = clean(messageText(e.content), textLimit);
        if (text) recent.push({ kind: 'text', text, at, role });
      } else if (e.type === 'function_call') {
        recent.push({ kind: 'tool', text: toolSummary(String(e.name ?? 'tool'), e.arguments), at });
      } else {
        const body = clean(resultText(e.output), textLimit);
        if (body) {
          recent.push({
            kind: 'tool_result',
            text: body,
            at,
            isError: e.status !== undefined && e.status !== 'completed',
          });
        }
      }
    }
  }

  const activityCapped = activityTotal > recent.length;
  return {
    sessionId,
    file,
    pending,
    tail,
    recent,
    updatedAt,
    // 只在真的不全时才带上，避免前端多做一次无意义的判断分支
    ...(fileTooLarge || activityCapped
      ? { partial: { fileTooLarge, activityCapped, totalEntries: activityTotal, shown: recent.length } }
      : {}),
  };
}
