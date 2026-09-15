/**
 * WorkBuddy 宿主只读适配层
 * ---------------------------------------------------------------------------
 * 用途：把 WorkBuddy（宿主）的任务与工作空间数据以**只读**方式暴露给看板，
 *       使看板成为 WorkBuddy 的统一观测台。
 *
 * ⚠️ 铁律：本模块**绝对不允许**对宿主库执行任何写操作（INSERT/UPDATE/DELETE/
 *    CREATE/DROP/PRAGMA 写操作）。宿主库承载用户全部会话历史与自动化配置，
 *    写坏不可恢复。连接以 readonly 模式打开，从驱动层面杜绝误写。
 *
 * 数据来源（~/.workbuddy）：
 *   - workbuddy.db : workspaces / sessions / automations / automation_runs
 *   - tasks/<uuid>/<n>.json : 任务子项（subject/description/activeForm/status）
 *
 * 设计要点：
 *   - 所有查询失败都降级为空结果 + available:false，绝不让宿主问题拖垮看板
 *   - 宿主库可能处于写入中（WAL），只读打开是安全的，不会阻塞宿主
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
// 路径安全校验（防 id 里的 `..` 逃出宿主 tasks/ 目录）—— 见 hostId.ts 顶部说明
import { isSafeHostId, isInsideDir } from './hostId.js';

/** 宿主根目录：优先 CODEBUDDY_CONFIG_DIR，回退 ~/.workbuddy */
function resolveHostDir(): string {
  const fromEnv = process.env.CODEBUDDY_CONFIG_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.join(os.homedir(), '.workbuddy');
}

const HOST_DIR = resolveHostDir();
const HOST_DB_PATH = path.join(HOST_DIR, 'workbuddy.db');
const HOST_TASKS_DIR = path.join(HOST_DIR, 'tasks');

// ============= 类型定义 =============

/** 宿主工作空间 */
export interface HostWorkspace {
  path: string;
  last_opened_at: number;
}

/** 宿主会话（即一次执行中的任务） */
export interface HostSession {
  id: string;
  cwd: string;
  /** 优先 custom_title（用户改名），回退 title */
  title: string | null;
  status: string;
  model: string | null;
  source_mode: string | null;
  is_background_automation: number | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number | null;
  /** 是否疑似僵尸：状态 working 但长时间无活动 */
  isStale?: boolean;
  /** 距最近一次活动的毫秒数（无活动记录时回退 updated_at） */
  idleMs?: number;
}

/** 宿主自动化（定时任务） */
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
   * 「上次执行」时间。
   * ⚠️ **不能只读 `automations.last_run_at`** —— 本机实测该列**恒为 null**
   * （WB 把运行态写在 `automation_runtime_state.last_run_at`）。
   * 取值为 `COALESCE(runtime_state.last_run_at, automations.last_run_at)`。
   * 踩过的坑：抽屉里「上次执行」显示"从未执行"，而同屏的「最近一次运行」却有时间和结果（自相矛盾）。
   */
  last_run_at: number | null;
  cwds: string[];
  model_id: string | null;
  created_at: number;
  updated_at: number;
  /** 是否正在执行（`automation_runtime_state.running`） */
  is_running: boolean;
  /** 本次运行的开始时间（仅 running 时有值） */
  running_started_at: number | null;
  /** 本次运行对应的会话 id（仅 running 时有值） */
  running_conversation_id: string | null;
}

/** 宿主自动化的一次运行记录 */
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

/** 宿主任务子项 */
export interface HostTaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** 宿主快照（一次性返回给前端） */
export interface HostSnapshot {
  available: boolean;
  hostDir: string;
  error?: string;
  workspaces: HostWorkspace[];
  workingSessions: HostSession[];
  /**
   * **正在等用户回应**的会话（宿主 `status = 'pending'`）。
   *
   * 这是用户报过的 bug：他在 WorkBuddy 里发起任务、Agent 反问「选一还是选二」，
   * WorkBuddy 界面显示「待确认」——**但看板的「待决策」列里看不到它**。
   * 根因：看板只拉 `working` 与 `completed/error`，`pending` 这个状态压根没被读取。
   *
   * 所以单独取出来，交给「待决策」列展示（卡片刻意标成「待确认」）。
   */
  awaitingSessions: HostSession[];
  /**
   * **已结束但未归档**的会话（status = completed / error），**不含自动化定时任务的运行**。
   *
   * 两件事：
   *  ① 这些是「还可以继续聊」的对话，用户期望在看板里找到它们并接着交代新任务
   *     （「已完成」板块；续聊走 CLI 的 `POST /api/v1/jobs/resume`）；
   *  ② ⚠️ 自动化定时任务的运行**也是**这种会话，但用户明确要求
   *     「已完成里应该抛开自动化定时任务」—— 否则同一个自动化会同时出现在
   *     「自动化定时」和「已完成」两列。判据是 `is_background_automation = 1`。
   */
  finishedSessions: HostSession[];
  /** 出错结束、需要人去处理的会话（status=error）→ 看板「待办」列（带特别标志） */
  errorSessions: HostSession[];
  recentSessions: HostSession[];
  automations: HostAutomation[];
  /** automation_id -> 最近一次运行 */
  latestRuns: Record<string, HostAutomationRun>;
  stats: {
    workspaces: number;
    sessionsTotal: number;
    sessionsWorking: number;
    /** 正在等用户回应的会话数（pending） */
    sessionsAwaiting: number;
    /** 未归档、非运行中、且非自动化运行的会话数（= finishedSessions 的总数，非截断值） */
    sessionsFinished: number;
    /** 出错结束的会话数（= errorSessions 的总数） */
    sessionsErrored: number;
    automationsActive: number;
  };
  fetchedAt: string;
}

/**
 * 「已结束但未归档」的会话状态集合。
 * ⚠️ 必须**显式枚举**而不是 `status != 'archived' && status != 'working'` ——
 * 后者会把 pending（等用户回应）这种中间态也当成"已完成"，归类就悄悄错了。
 * 本机实测的会话状态全集：archived / completed / error / pending / working。
 */
/** 已完成：真正正常结束的（error 不再算这里，见 ERROR_SESSION_STATUSES） */
const FINISHED_SESSION_STATUSES = ['completed'];

/**
 * 出错结束的会话。
 * 用户要求：「error 也应该归入**待办**，同时给一个特别的标志」—— 出错的东西需要人去处理，
 * 混在「已完成」里会被当成做完了而漏掉。
 */
const ERROR_SESSION_STATUSES = ['error'];

/** 正在等用户回应的状态（WorkBuddy 界面显示为「待确认」） */
const AWAITING_SESSION_STATUSES = ['pending'];

/** 已完成板块最多展示多少条会话（避免历史越积越长把列撑爆） */
const FINISHED_SESSION_LIMIT = 30;

/**
 * 排除「自动化定时任务的运行」。
 *
 * 用户反馈：「已完成栏目里应该抛开自动化定时任务，两个栏目里都有自动化定时任务」。
 * 自动化每次运行都会留下一条 completed 会话，若不排除，同一个自动化就会同时出现在
 * 「自动化定时」（配置本身）和「已完成」（它的运行记录）两列。
 */
const NOT_AUTOMATION_RUN = '(is_background_automation IS NULL OR is_background_automation = 0)';

/**
 * 排除「项目作用域」的会话 —— 它们**不属于** WB 侧边栏的空间列表。
 *
 * 🔴 2026-09-15 实测定位（用户反馈「看板已完成与 WB 不一致」，逐条比对后）：
 *   `梳理项目工作记录` 在 WB 侧边栏和归档里**都找不到**，而看板显示它。
 *   与同工作空间的"兄弟会话"逐字段对比，两个独立信号指向同一结论：
 *     · `source_mode = NULL`（其余 12 条未归档会话都是 `'craft'`）
 *     · `project_id = p_0d2fba65…`（唯一一条）
 *     · `plugin_context_json` 含 `projectResources` ⇒ 创建自「项目」上下文
 *   ⇒ 它是**项目内部**的会话，WB 收在项目视图里，所以空间列表看不到。
 *
 * ⚠️ 不要用 `source_mode IS NULL` 当判据 —— 那只是这台的巧合表现；
 *    `project_id` 有明确语义，与 `plugin_context_json.projectResources` 互相印证。
 *
 * ⚠️ 与 `NOT_PLAYGROUND` 的区别（2026-09-15 用户拍板）：
 *   playground（试玩）会话 **WB 是显示的**，只是放在顶部独立的「任务」分区 ⇒
 *   **不要排除**，仍应出现在看板「已完成」里。
 */
const NOT_PROJECT_SCOPED = '(project_id IS NULL)';

/** 读取指定状态下的会话数（供调度器占用计算与界面提示复用） */
export function getHostSessionStats(): {
  working: number;
  awaiting: number;
  finished: number;
  errored: number;
  total: number;
} {
  const db = getHostDb();
  if (!db) return { working: 0, awaiting: 0, finished: 0, errored: 0, total: 0 };
  const finPlaceholders = FINISHED_SESSION_STATUSES.map(() => '?').join(',');
  const awaitPlaceholders = AWAITING_SESSION_STATUSES.map(() => '?').join(',');
  const errPlaceholders = ERROR_SESSION_STATUSES.map(() => '?').join(',');
  return {
    working: safeCount(
      db,
      `SELECT count(*) c FROM sessions
        WHERE deleted_at IS NULL AND status = 'working' AND ${NOT_PROJECT_SCOPED}`,
    ),
    awaiting: safeCount(
      db,
      `SELECT count(*) c FROM sessions
        WHERE deleted_at IS NULL AND status IN (${awaitPlaceholders}) AND ${NOT_PROJECT_SCOPED}`,
      AWAITING_SESSION_STATUSES,
    ),
    // 与 errorSessions 列表口径一致（同样排除自动化运行与 playground）
    errored: safeCount(
      db,
      `SELECT count(*) c FROM sessions
        WHERE deleted_at IS NULL AND status IN (${errPlaceholders}) AND ${NOT_AUTOMATION_RUN} AND ${NOT_PROJECT_SCOPED}`,
      ERROR_SESSION_STATUSES,
    ),
    // 与 finishedSessions 列表口径保持一致（同样排除自动化运行与 playground），
    // 否则列头计数与列里卡片数会对不上
    finished: safeCount(
      db,
      `SELECT count(*) c FROM sessions
        WHERE deleted_at IS NULL AND status IN (${finPlaceholders}) AND ${NOT_AUTOMATION_RUN} AND ${NOT_PROJECT_SCOPED}`,
      FINISHED_SESSION_STATUSES,
    ),
    total: safeCount(db, 'SELECT count(*) c FROM sessions WHERE deleted_at IS NULL'),
  };
}

/**
 * 读取「已结束但未归档且不是自动化运行」的会话。
 * 单独写一条查询而不是复用 getHostSessions，是因为要带 `is_background_automation` 过滤。
 */
export function getHostFinishedSessions(limit = FINISHED_SESSION_LIMIT): HostSession[] {
  const db = getHostDb();
  if (!db) return [];
  const placeholders = FINISHED_SESSION_STATUSES.map(() => '?').join(',');
  const cols = `id, cwd, title, custom_title, status, model, source_mode,
                is_background_automation, created_at, updated_at, last_activity_at`;
  const rows = safeQuery<HostSession & { custom_title?: string | null }>(
    db,
    `SELECT ${cols} FROM sessions
      WHERE deleted_at IS NULL AND status IN (${placeholders}) AND ${NOT_AUTOMATION_RUN} AND ${NOT_PROJECT_SCOPED}
      ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
      LIMIT ?`,
    [...FINISHED_SESSION_STATUSES, limit],
  );
  return rows.map(decorateSession);
}

/**
 * 读取出错结束的会话（status=error）—— 归入看板「待办」列并带特别标志。
 * 与 getHostFinishedSessions 同一套过滤（排除自动化运行），只是状态不同。
 */
export function getHostErrorSessions(limit = FINISHED_SESSION_LIMIT): HostSession[] {
  const db = getHostDb();
  if (!db) return [];
  const placeholders = ERROR_SESSION_STATUSES.map(() => '?').join(',');
  const cols = `id, cwd, title, custom_title, status, model, source_mode,
                is_background_automation, created_at, updated_at, last_activity_at`;
  const rows = safeQuery<HostSession & { custom_title?: string | null }>(
    db,
    `SELECT ${cols} FROM sessions
      WHERE deleted_at IS NULL AND status IN (${placeholders}) AND ${NOT_AUTOMATION_RUN} AND ${NOT_PROJECT_SCOPED}
      ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
      LIMIT ?`,
    [...ERROR_SESSION_STATUSES, limit],
  );
  return rows.map(decorateSession);
}

/**
 * 按 id 读取单个宿主会话（只读）。
 * 用途：点击卡片后展示上下文 —— 宿主快照只带最近 N 条，
 * 用户点开的可能是更早的会话。
 */
export function getHostSessionById(id: string): HostSession | null {
  const db = getHostDb();
  if (!db) return null;
  const cols = `id, cwd, title, custom_title, status, model, source_mode,
                is_background_automation, created_at, updated_at, last_activity_at`;
  const rows = safeQuery<HostSession & { custom_title?: string | null }>(
    db,
    `SELECT ${cols} FROM sessions WHERE deleted_at IS NULL AND id = ? LIMIT 1`,
    [id],
  );
  return rows.length ? decorateSession(rows[0]) : null;
}

// ============= 连接管理 =============

let hostDb: Database.Database | null = null;
let lastOpenError: string | null = null;
let cachedPath: string | null = null;

/**
 * 打开宿主库（只读）。采用缓存 + 路径变更检测：
 * 若宿主目录发生变化（例如用户切换了配置目录），重新建连。
 */
function getHostDb(): Database.Database | null {
  if (hostDb && cachedPath === HOST_DB_PATH) return hostDb;

  // 路径变了，先关旧连接
  if (hostDb) {
    try { hostDb.close(); } catch { /* 忽略关闭异常 */ }
    hostDb = null;
  }

  if (!fs.existsSync(HOST_DB_PATH)) {
    lastOpenError = `宿主数据库不存在: ${HOST_DB_PATH}`;
    return null;
  }

  try {
    hostDb = new Database(HOST_DB_PATH, {
      readonly: true,      // 驱动层只读，杜绝误写
      fileMustExist: true,
    });
    // 查询超时保护：宿主库若被长事务占用，避免看板请求无限等待
    hostDb.pragma('busy_timeout = 2000');
    cachedPath = HOST_DB_PATH;
    lastOpenError = null;
    return hostDb;
  } catch (err: any) {
    lastOpenError = `打开宿主数据库失败: ${err?.message || err}`;
    hostDb = null;
    return null;
  }
}

/** 探测宿主数据是否可用（供前端提示用） */
export function isHostAvailable(): { available: boolean; hostDir: string; error?: string } {
  const db = getHostDb();
  if (!db) {
    return { available: false, hostDir: HOST_DIR, error: lastOpenError || '未知错误' };
  }
  return { available: true, hostDir: HOST_DIR };
}

// ============= 查询实现 =============

/** 安全执行查询：任何异常都降级为空数组 */
function safeQuery<T>(db: Database.Database, sql: string, params: any[] = []): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch (err: any) {
    console.warn(`[HostAdapter] 查询失败: ${err?.message || err}`);
    return [];
  }
}

function safeCount(db: Database.Database, sql: string, params: any[] = []): number {
  try {
    const row = db.prepare(sql).get(...params) as { c?: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** 读取宿主工作空间列表 */
export function getHostWorkspaces(): HostWorkspace[] {
  const db = getHostDb();
  if (!db) return [];
  return safeQuery<HostWorkspace>(
    db,
    'SELECT path, last_opened_at FROM workspaces ORDER BY last_opened_at DESC',
  );
}

/**
 * 判定会话是否疑似僵尸：状态为 working，但已超过阈值无活动。
 * 宿主偶尔会因异常退出留下状态卡在 working 的会话，看板需能识别并标注，
 * 避免用户误以为任务仍在执行。
 */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

function decorateSession(s: HostSession & { custom_title?: string | null }): HostSession {
  const lastActivity = s.last_activity_at ?? s.updated_at ?? s.created_at;
  const idleMs = Date.now() - lastActivity;
  return {
    ...s,
    title: s.custom_title || s.title,
    idleMs,
    isStale: s.status === 'working' && idleMs > STALE_THRESHOLD_MS,
  };
}

/**
 * 读取宿主会话。
 * @param statuses 过滤状态；不传则返回全部（排除已软删除）
 * @param limit 条数上限
 */
export function getHostSessions(statuses?: string[], limit = 50): HostSession[] {
  const db = getHostDb();
  if (!db) return [];

  const cols = `id, cwd, title, custom_title, status, model, source_mode,
                is_background_automation, created_at, updated_at, last_activity_at`;

  type Row = HostSession & { custom_title?: string | null };

  if (statuses && statuses.length > 0) {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = safeQuery<Row>(
      db,
      `SELECT ${cols} FROM sessions
       WHERE deleted_at IS NULL AND status IN (${placeholders}) AND ${NOT_PROJECT_SCOPED}
       ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
       LIMIT ?`,
      [...statuses, limit],
    );
    return rows.map(decorateSession);
  }

  const rows = safeQuery<Row>(
    db,
    `SELECT ${cols} FROM sessions
     WHERE deleted_at IS NULL AND ${NOT_PROJECT_SCOPED}
     ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map(decorateSession);
}

/** 读取宿主自动化（定时任务） */
export function getHostAutomations(): HostAutomation[] {
  const db = getHostDb();
  if (!db) return [];

  /**
   * ⚠️ 必须 LEFT JOIN `automation_runtime_state`：
   *  · `automations.last_run_at` 本机**恒为 null**，真正的「上次执行」在 runtime_state
   *  · 运行状态（running / running_started_at / running_conversation_id）也只在 runtime_state
   * ⇒ 前者决定「上次执行」显示是否正确，后者决定"运行中的自动化要不要从定时列挪走"。
   */
  const rows = safeQuery<
    Omit<HostAutomation, 'cwds' | 'is_running'> & { cwds: string; is_running: number | null }
  >(
    db,
    `SELECT a.id, a.name, a.prompt, a.status, a.schedule_type, a.rrule, a.scheduled_at,
            a.valid_from, a.valid_until, a.next_run_at,
            COALESCE(s.last_run_at, a.last_run_at) AS last_run_at,
            a.cwds, a.model_id, a.created_at, a.updated_at,
            COALESCE(s.running, 0) AS is_running,
            s.running_started_at AS running_started_at,
            s.running_conversation_id AS running_conversation_id
     FROM automations a
     LEFT JOIN automation_runtime_state s ON s.automation_id = a.id
     WHERE a.deleted_at IS NULL
     ORDER BY COALESCE(a.next_run_at, a.updated_at) ASC`,
  );

  return rows.map(r => ({
    ...r,
    // cwds 在宿主里是 JSON 字符串（如 ["C:\\path"]），解析失败则置空
    cwds: parseCwds(r.cwds),
    is_running: Number(r.is_running) === 1,
  }));
}

function parseCwds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 读取每个自动化最近一次运行记录，按 automation_id 建索引 */
export function getLatestAutomationRuns(): Record<string, HostAutomationRun> {
  const db = getHostDb();
  if (!db) return {};

  const rows = safeQuery<HostAutomationRun>(
    db,
    `SELECT thread_id, automation_id, status, thread_title, source_cwd,
            result_success, created_at, updated_at
     FROM automation_runs
     ORDER BY created_at DESC
     LIMIT 200`,
  );

  const out: Record<string, HostAutomationRun> = {};
  for (const r of rows) {
    // 因为已按 created_at DESC 排序，首次遇到即为该 automation 的最新一次
    if (!out[r.automation_id]) out[r.automation_id] = r;
  }
  return out;
}

/**
 * 读取宿主任务子项（tasks/<uuid>/<n>.json）。
 * @param sessionId 只读某个会话的任务；不传则汇总最近若干个
 */
export function getHostTaskItems(sessionId?: string): HostTaskItem[] {
  if (!fs.existsSync(HOST_TASKS_DIR)) return [];

  /**
   * 🔴 2026-09-16 加（审计 M1）：`sessionId` 来自 query
   * （`GET /api/host/task-items?sessionId=…`）。不校验的话，`sessionId=../../..`
   * 会让 `path.join` 逃出宿主 `tasks/` 目录，进而遍历任意目录、
   * 读出其中所有含 `subject` 字段的 `*.json`。
   */
  if (sessionId !== undefined && !isSafeHostId(sessionId)) return [];

  let dirs: string[];
  try {
    dirs = sessionId
      ? [path.join(HOST_TASKS_DIR, sessionId)]
          .filter(d => isInsideDir(HOST_TASKS_DIR, d)) // 纵深防御
          .filter(d => fs.existsSync(d))
      : fs
          .readdirSync(HOST_TASKS_DIR)
          .map(d => path.join(HOST_TASKS_DIR, d))
          .filter(d => {
            try { return fs.statSync(d).isDirectory(); } catch { return false; }
          })
          .sort((a, b) => {
            // 按目录修改时间倒序，取最近的
            try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
          })
          .slice(0, 20);
  } catch (err: any) {
    console.warn(`[HostAdapter] 读取 tasks 目录失败: ${err?.message || err}`);
    return [];
  }

  const items: HostTaskItem[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && obj.subject) {
          items.push({
            id: String(obj.id ?? f.replace(/\.json$/, '')),
            subject: String(obj.subject),
            description: String(obj.description ?? ''),
            activeForm: String(obj.activeForm ?? ''),
            status: String(obj.status ?? 'unknown'),
            createdAt: Number(obj.createdAt ?? 0),
            updatedAt: Number(obj.updatedAt ?? 0),
          });
        }
      } catch {
        // 单个文件解析失败不影响整体
      }
    }
  }
  return items;
}

// ============= 聚合快照 =============

/**
 * 生成宿主数据快照。这是前端主要消费的接口。
 * 任何环节失败都降级为空数据 + available:false，不抛异常。
 */
export function getHostSnapshot(): HostSnapshot {
  const probe = isHostAvailable();

  if (!probe.available) {
    return {
      available: false,
      hostDir: probe.hostDir,
      error: probe.error,
      workspaces: [],
      workingSessions: [],
      awaitingSessions: [],
      finishedSessions: [],
      errorSessions: [],
      recentSessions: [],
      automations: [],
      latestRuns: {},
      stats: {
        workspaces: 0,
        sessionsTotal: 0,
        sessionsWorking: 0,
        sessionsAwaiting: 0,
        sessionsFinished: 0,
        sessionsErrored: 0,
        automationsActive: 0,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  const db = getHostDb()!;
  const workspaces = getHostWorkspaces();
  const workingSessions = getHostSessions(['working'], 50);
  const awaitingSessions = getHostSessions(AWAITING_SESSION_STATUSES, 50);
  const finishedSessions = getHostFinishedSessions(FINISHED_SESSION_LIMIT);
  const errorSessions = getHostErrorSessions(FINISHED_SESSION_LIMIT);
  const recentSessions = getHostSessions(undefined, 30);
  const automations = getHostAutomations();
  const latestRuns = getLatestAutomationRuns();
  const sessionStats = getHostSessionStats();

  return {
    available: true,
    hostDir: probe.hostDir,
    workspaces,
    workingSessions,
    awaitingSessions,
    finishedSessions,
    errorSessions,
    recentSessions,
    automations,
    latestRuns,
    stats: {
      workspaces: workspaces.length,
      sessionsTotal: sessionStats.total,
      sessionsWorking: sessionStats.working,
      sessionsAwaiting: sessionStats.awaiting,
      // 用统计值而不是 finishedSessions.length，避免被展示用的截断数掩盖真实规模
      sessionsFinished: sessionStats.finished,
      sessionsErrored: sessionStats.errored,
      automationsActive: safeCount(
        db,
        "SELECT count(*) c FROM automations WHERE deleted_at IS NULL AND status = 'ACTIVE'",
      ),
    },
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 判断某工作空间当前是否有宿主会话在跑。
 * 供看板派发任务前做互锁检查（避免与 WorkBuddy 撞同一目录）。
 */
export function isWorkspaceBusy(workspacePath: string): boolean {
  const db = getHostDb();
  if (!db) return false;
  const n = safeCount(
    db,
    `SELECT count(*) c FROM sessions
     WHERE deleted_at IS NULL AND status = 'working' AND cwd = ?`,
    [workspacePath],
  );
  return n > 0;
}

/** 关闭连接（用于优雅退出） */
export function closeHostDb(): void {
  if (hostDb) {
    try { hostDb.close(); } catch { /* 忽略 */ }
    hostDb = null;
    cachedPath = null;
  }
}

/**
 * 从宿主历史中收集真实使用过的模型 ID。
 *
 * 用途：看板的 `/api/models` 在 SDK 拿不到模型列表时，需要一份**真实可用**的
 * 模型名回落。绝不能硬编码 `claude-sonnet-4` —— 那不是 WorkBuddy 注册的模型 ID，
 * 用它派发任务会得到 `400 model [...] service info not found`。
 *
 * 数据来源（按优先级）：
 *   1. sessions.model  —— 实际跑过任务的模型，可信度最高
 *   2. automations.model_id —— 定时任务配置里用过的模型
 *
 * 返回按使用频次降序去重，最多 12 个。
 */
export function getObservedModels(): string[] {
  const db = getHostDb();
  if (!db) return [];

  const counter = new Map<string, number>();
  const bump = (id: unknown) => {
    if (typeof id !== 'string') return;
    const v = id.trim();
    if (!v) return;
    counter.set(v, (counter.get(v) ?? 0) + 1);
  };

  // 1) 会话实际用过的模型（频次最高，权重也最高 → 计 2 次）
  const sessRows = safeQuery<{ model: string | null }>(
    db,
    `SELECT model FROM sessions WHERE model IS NOT NULL AND model <> ''`,
  );
  for (const r of sessRows) {
    bump(r.model);
    if (r.model) bump(r.model); // 加权
  }

  // 2) 定时任务配置里的模型
  const autoRows = safeQuery<{ model_id: string | null }>(
    db,
    `SELECT model_id FROM automations WHERE model_id IS NOT NULL AND model_id <> ''`,
  );
  for (const r of autoRows) bump(r.model_id);

  return Array.from(counter.keys())
    .sort((a, b) => (counter.get(b) ?? 0) - (counter.get(a) ?? 0))
    .slice(0, 12);
}
