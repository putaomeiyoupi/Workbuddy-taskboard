import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库文件路径
// 支持通过 CHAT_DB_PATH 覆盖：便于测试时使用隔离库，
// 避免与正在运行的其他看板实例争抢同一个 data/chat.db。
const dbPath = process.env.CHAT_DB_PATH
  ? path.resolve(process.env.CHAT_DB_PATH)
  : path.join(__dirname, '..', 'data', 'chat.db');

/** 实际使用的数据库文件路径（供启动横幅等展示，避免硬编码误导） */
export const DB_FILE_PATH = dbPath;

// 确保 data 目录存在
import fs from 'fs';
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 创建数据库连接
// 显式标注类型：否则 tsc -b 在做声明推断时会报 TS4023
// （无法为外部模块的 BetterSqlite3.Database 命名）
const db: BetterSqlite3Database = new Database(dbPath);

// 启用 WAL 模式以提高性能
db.pragma('journal_mode = WAL');
// ⚠️ 必须开启外键约束，否则 ON DELETE CASCADE 形同虚设。
// 此前未开启，导致一个隐藏问题：删会话时 messages 不会被级联删除，留下孤儿行。
// 打开后仅对**后续写入**生效（不会回溯校验既有数据），因此是安全的。
db.pragma('foreign_keys = ON');

// 初始化数据库表
db.exec(`
  -- 会话表
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    sdk_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 消息表
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    tool_calls TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- 为会话 ID 创建索引
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

  -- 工作空间表：任务执行的工作目录，同时是调度互锁的维度
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    max_concurrency INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    color TEXT,
    created_at TEXT NOT NULL
  );

  -- 任务表：看板核心实体
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    workspace_id TEXT,
    model TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    priority INTEGER NOT NULL DEFAULT 1,
    scheduled_at TEXT,
    depends_on TEXT,
    decision_prompt TEXT,
    decision_options TEXT,
    decision_answer TEXT,
    session_id TEXT,
    sdk_session_id TEXT,
    result TEXT,
    error TEXT,
    progress_log TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);

  -- 设置表：全局可调参数（全局并发上限等）
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 交互表：需要人工介入的请求（权限确认 / 决策提问）
  --
  -- 为什么要独立成表，而不是像以前那样在 tasks 上放三个列：
  --   ① request_id 唯一 → **幂等去重**。轮询 job 状态时同一段「权限被拒」
  --      文案可能被读到多次，不去重就会重复建决策。
  --   ② 一个任务可能有**多次**决策，且需要历史可追溯（三个列只能存最后一次）。
  --   ③ blocking_scope 明确「这条交互阻塞谁」，为将来「只阻塞子任务」留余地。
  CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    blocking_scope TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'resolved', 'canceled')),
    response TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_request
    ON interactions(request_id);

  -- 任务依赖（前置关系）。blocker 必须先 done，blocked 才能被调度。
  --
  -- 为什么从 tasks.depends_on 的 JSON 数组改过来：
  --   ① JSON 数组没有任何完整性保证 —— 可以写进不存在的 id、可以成环、
  --      任务删除后残留悬空引用（旧实现全靠应用层自觉）。
  --   ② 无法建索引，"X 被谁依赖" 这类反查要全表扫。
  --   ③ CHECK 直接挡掉自环（blocker <> blocked）。
  CREATE TABLE IF NOT EXISTS task_dependencies (
    blocker_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocked_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (blocker_task_id, blocked_task_id),
    CHECK (blocker_task_id <> blocked_task_id)
  );

  CREATE INDEX IF NOT EXISTS idx_dependencies_blocked
    ON task_dependencies(blocked_task_id);

  -- 执行历史：每次派发一条，重试不会覆盖上一条。
  --
  -- 为什么值得单独一张表：task 上只能存「最新状态」，
  -- 重试后上一次的失败原因、耗时、用了哪个工作树全部丢失，
  -- 排查「为什么重试还是失败」时没有线索。
  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_state TEXT NOT NULL,
    host_job_id TEXT,
    host_session_id TEXT,
    worktree_path TEXT,
    result TEXT,
    structured_error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_task_runs_task
    ON task_runs(task_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_interactions_task_status
    ON interactions(task_id, status);
`);

// 数据库迁移：添加 sdk_session_id 列（如果不存在）
try {
  const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasColumn = tableInfo.some(col => col.name === 'sdk_session_id');
  if (!hasColumn) {
    db.exec("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT");
    console.log("[DB] Added sdk_session_id column to sessions table");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

/**
 * 幂等地给表补列。
 *
 * ⚠️ 每次都用**新的** PRAGMA 快照 —— 早先的写法只读一次快照再连续判断多列，
 * 一旦先执行了一次 ALTER，后续判断依据就是过期的表结构。
 */
function ensureColumn(table: string, column: string, ddl: string, note: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[DB] 已添加 ${table}.${column} 列（${note}）`);
}

// ===========================================================================
// Schema 版本与迁移
//
// 为什么版本化：此前迁移是散落的 `ensureColumn` + 若干独立 try 块，
// 每段靠「探测某个列在不在」自行决定跑不跑。迁移一多就有两个问题：
//   ① 表达不了**顺序与依赖**，只能各自探测；
//   ② 没有地方记录「当前处在哪一版」，排查时只能靠猜。
//
// 现在统一为：schema_meta 记版本 → 按版本号顺序应用未执行的迁移。
// 基线（v1）即「建表语句产出的结构」，因此：
//   - 全新库：依次跑完 v1..SCHEMA_VERSION
//   - 已有库：把现存结构视为已到基线，只补跑缺失的后续迁移
//
// 🔴 铁律：**每个 up() 都必须幂等**。无法保证每次都从干净库开始，
// 也不能假设上一版恰好执行过。
// ===========================================================================

/**
 * 当前 schema 版本。新增迁移时 +1，并在 MIGRATIONS 末尾追加一项。
 *
 * ⚠️ **两个地方都要改**：`runMigrations()` 用 `from >= SCHEMA_VERSION` 提前返回，
 * 忘了 +1 会让新迁移被**静默跳过**（日志里连"[DB] schema 版本 x → y"都不会打印，
 * 现象是"迁移写了但库没变"）。本次加 v6 时就踩了一次，靠验收脚本的
 * `schemaVersion === 6` 断言抓出来 —— 所以迁移必须配一条版本断言。
 */
const SCHEMA_VERSION = 7;

interface Migration {
  version: number;
  description: string;
  up: () => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'tasks 扩展列：executor / host_session_id / host_job_id / isolation / worktree_path / wait_reason / run_state',
    up: () => {
        // 任务由谁执行。'workbuddy'（派发给宿主）已下线，见 内部归档 ⇒ 只剩 'local'
        ensureColumn('tasks', 'executor', `executor TEXT NOT NULL DEFAULT 'local'`, '本地执行器');
        // 关联的宿主会话 id（workbuddy 执行器写入）
        ensureColumn('tasks', 'host_session_id', `host_session_id TEXT`, 'workbuddy 会话');
        // 关联的宿主 job id。
        // ⚠️ 必须有独立列：官方 `POST /api/v1/jobs/{id}/reply|stop` 要的是 **job id**，
        // 而 job.id 与 sessionId 虽然当前实现里长得很像（id 常是 sessionId 的前 8 位），
        // 但那是实现细节，不能依赖它反推。
        // ⚠️ 已无写入方（CLI 派发通道下线后不再有宿主 job）；列保留供历史数据展示。
        ensureColumn('tasks', 'host_job_id', `host_job_id TEXT`, '宿主 job id（历史数据）');
        // 隔离模式：'shared' = 直接在工作空间目录里改（默认，配合工作空间互锁串行）。
        // ⚠️ 'worktree' 已不可用（原实现依赖已下线的 CLI 派发通道，见 内部归档），
        //    但类型与列都保留 —— 历史数据里可能仍是 'worktree'，删列需要迁移。
        ensureColumn('tasks', 'isolation', `isolation TEXT NOT NULL DEFAULT 'shared'`, `默认 shared`);
        // 实际使用的工作树路径。**已无写入方**（worktree 模式不可用），列保留供历史数据展示。
        ensureColumn('tasks', 'worktree_path', `worktree_path TEXT`, '隔离模式的工作树路径');
        // 等待原因。非空表示任务**有意保留占用**、等待人工核对或条件满足，
        // 而不是处于正常的执行中。用于表达「不确定」状态：
        // 连接中断 ≠ 执行已停止，此时贸然释放占用会让同空间的下一个任务并发写同一目录。
        ensureColumn('tasks', 'wait_reason', `wait_reason TEXT`, '保留占用并等待核对的原因');
        // 执行阶段。仅当 status='in_progress' 时有意义，见 TaskRunState 的注释。
        ensureColumn('tasks', 'run_state', `run_state TEXT`, `进行中的细分阶段（默认 running）`);
    },
  },
  {
    version: 2,
    description: '状态模型两层化：running / pending_decision → in_progress + run_state',
    up: () => {
        const legacy = db
          .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('running','pending_decision')`)
          .get() as { cnt: number };

        if (legacy.cnt > 0) {
          const migrate = db.transaction(() => {
            db.prepare(
              `UPDATE tasks SET status='in_progress', run_state='running' WHERE status='running'`
            ).run();
            db.prepare(
              `UPDATE tasks SET status='in_progress', run_state='waiting_approval'
               WHERE status='pending_decision'`
            ).run();
          });
          migrate();
          console.log(`[DB] 已把 ${legacy.cnt} 条任务迁移到两层状态模型（status + run_state）`);
        }

        // 兜底：进行中但缺少 run_state 的行补上默认值
        const filled = db
          .prepare(`UPDATE tasks SET run_state='running' WHERE status='in_progress' AND run_state IS NULL`)
          .run();
        if (filled.changes > 0) {
          console.log(`[DB] 已为 ${filled.changes} 条进行中任务补上 run_state='running'`);
        }
    },
  },
  {
    version: 3,
    description: '把 tasks 上遗留的决策列搬进 interactions 表',
    up: () => {
        const legacy = db
          .prepare(
            `SELECT t.id, t.decision_prompt, t.decision_options
               FROM tasks t
              WHERE t.decision_prompt IS NOT NULL AND t.decision_prompt != ''
                AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.task_id = t.id)`
          )
          .all() as Array<{ id: string; decision_prompt: string; decision_options: string | null }>;

        if (legacy.length > 0) {
          for (const row of legacy) {
            let options: string[] = [];
            try {
              const parsed = row.decision_options ? JSON.parse(row.decision_options) : [];
              if (Array.isArray(parsed)) options = parsed.filter((o: unknown) => typeof o === 'string');
            } catch {
              options = [];
            }
            createInteraction({
              taskId: row.id,
              kind: 'manual',
              // 迁移来的记录用稳定 requestId，重复启动不会重复插入
              requestId: `legacy:${row.id}`,
              payload: { prompt: row.decision_prompt, options },
            });
          }
          console.log(`[DB] 已把 ${legacy.length} 条遗留决策迁移到 interactions 表`);
        }
    },
  },
  {
    version: 4,
    description: '把 tasks.depends_on 的 JSON 数组搬进 task_dependencies join 表',
    up: () => {
      const rows = db
        .prepare(`SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL AND depends_on != ''`)
        .all() as Array<{ id: string; depends_on: string }>;

      let migrated = 0;
      const insert = db.prepare(
        `INSERT OR IGNORE INTO task_dependencies(blocker_task_id, blocked_task_id, created_at)
         VALUES (?, ?, ?)`
      );
      const now = new Date().toISOString();

      for (const row of rows) {
        let deps: unknown;
        try { deps = JSON.parse(row.depends_on); } catch { continue; }
        if (!Array.isArray(deps)) continue;
        for (const dep of deps) {
          if (typeof dep !== 'string' || !dep || dep === row.id) continue;
          // 悬空引用（依赖的任务已被删）跳过 —— join 表有外键，插也插不进
          if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(dep)) continue;
          insert.run(dep, row.id, now);
          migrated++;
        }
      }
      if (migrated > 0) console.log(`[DB] 已迁移 ${migrated} 条任务依赖到 task_dependencies`);
    },
  },
  {
    version: 5,
    description: 'tasks 增加 scopes 列（声明的修改范围，JSON 数组）',
    up: () => {
      // 用 JSON 数组而不是独立表：范围是纯路径字符串，没有外部参照，
      // 建表带不来完整性收益；而重叠判定是前缀匹配，本来就要在应用层做。
      ensureColumn('tasks', 'scopes', `scopes TEXT`, '声明的修改范围（JSON 数组）');
    },
  },
  {
    version: 6,
    description: '工作空间路径唯一：合并同路径重复项 + lower(path) 唯一索引',
    up: () => {
      /**
       * ⚠️ 这不只是「看着乱」——**同路径的多个工作空间会破坏工作空间互锁**：
       * 互锁按 `workspace_id` 分组（`countTasksInWorkspace(ws.id)`），
       * 同一个目录挂两个 id，就等于两条互不相干的互锁键 → 同一目录可以并行跑两个任务，
       * 互相覆盖对方的改动。所以这里必须从数据层堵死，而不是只靠界面提醒。
       *
       * 先合并在建索引：否则已有重复行会让 CREATE UNIQUE INDEX 直接失败，
       * 而迁移失败会停在上一版反复重试（`up()` 必须幂等，见文件顶部纪律）。
       */
      const merged = mergeDuplicateWorkspaces();
      if (merged.removed > 0) {
        console.log(
          `[DB] 已合并 ${merged.groups} 组同路径工作空间，迁移 ${merged.movedTasks} 个任务，删除 ${merged.removed} 条重复记录`
        );
      }
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_path_unique
           ON workspaces(lower(trim(path)))`
      );
    },
  },
  {
    version: 7,
    description: 'tasks 增加定期循环列（repeat_mode / repeat_spec / repeat_until / repeat_limit / repeat_count / repeat_paused / repeat_last_at）',
    up: () => {
      /**
       * 需求（2026-09-15 用户）：定时任务增加「任务定期循环」选项，
       * 分「周期」（每天/每周/每月固定时刻）或「间隔」（每 N 分钟/小时/天）两种。
       * 规格与下次时间算法在 `server/repeat.ts`（纯函数，另有用例覆盖）。
       *
       * ⚠️ 全部带默认值，**保证已有行升级后语义不变**（旧任务一律视为不循环）。
       *    `repeat_mode` 默认 'none' 是关键：若默认成 'periodic'，
       *    升级瞬间所有历史定时任务都会开始无限循环。
       */
      ensureColumn('tasks', 'repeat_mode', `repeat_mode TEXT NOT NULL DEFAULT 'none'`, '循环模式');
      ensureColumn('tasks', 'repeat_spec', `repeat_spec TEXT`, '循环规格（JSON）');
      ensureColumn('tasks', 'repeat_until', `repeat_until TEXT`, '循环截止时间（ISO，含端点）');
      ensureColumn('tasks', 'repeat_limit', `repeat_limit INTEGER`, '最多执行轮次');
      ensureColumn('tasks', 'repeat_count', `repeat_count INTEGER NOT NULL DEFAULT 0`, '已执行轮次');
      ensureColumn('tasks', 'repeat_paused', `repeat_paused INTEGER NOT NULL DEFAULT 0`, '暂停开关');
      ensureColumn('tasks', 'repeat_last_at', `repeat_last_at TEXT`, '上一轮结束时间');
    },
  },
];

/**
 * 合并「同一路径」的重复工作空间。
 *
 * 保留规则：**最早创建的那条**（通常是用户真正建过的），
 * 其余记录上的任务一律改指到保留项，然后删除重复记录 —— 不丢任务，只收敛空间。
 *
 * 幂等：无重复时什么都不做。供迁移（v6）与手动「同步」复用。
 */
export function mergeDuplicateWorkspaces(): {
  groups: number;
  removed: number;
  movedTasks: number;
} {
  const dupGroups = db
    .prepare(
      `SELECT lower(trim(path)) AS key, count(*) AS c
         FROM workspaces GROUP BY key HAVING c > 1`
    )
    .all() as Array<{ key: string; c: number }>;

  let removed = 0;
  let movedTasks = 0;

  const run = db.transaction(() => {
    for (const g of dupGroups) {
      const rows = db
        .prepare(
          `SELECT id, path FROM workspaces
            WHERE lower(trim(path)) = ? ORDER BY created_at ASC, id ASC`
        )
        .all(g.key) as Array<{ id: string; path: string }>;
      if (rows.length < 2) continue;

      const keep = rows[0];
      for (const row of rows.slice(1)) {
        // 任务改指保留项：任务本身不丢，执行目录也不变（同一个路径）
        const res = db
          .prepare('UPDATE tasks SET workspace_id = ? WHERE workspace_id = ?')
          .run(keep.id, row.id);
        movedTasks += res.changes;
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(row.id);
        removed += 1;
      }
    }
  });
  run();

  return { groups: dupGroups.length, removed, movedTasks };
}

/** 统计引用某工作空间的任务数（删除前把关） */
export function countTasksUsingWorkspace(workspaceId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ?')
    .get(workspaceId) as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * 把某工作空间下的任务改挂到另一个工作空间。
 * 用途：删除空间但不想连带删任务时（同步差异里的「移除仅看板有的」）。
 */
export function reassignTasksWorkspace(fromId: string, toId: string): number {
  const res = db
    .prepare('UPDATE tasks SET workspace_id = ? WHERE workspace_id = ?')
    .run(toId, fromId);
  return res.changes;
}

/** 按路径查工作空间（大小写/首尾空白不敏感），用于创建时的幂等判定 */
export function findWorkspaceByPath(pathname: string): DbWorkspace | undefined {
  const row = db
    .prepare('SELECT * FROM workspaces WHERE lower(trim(path)) = lower(trim(?)) LIMIT 1')
    .get(pathname) as DbWorkspace | undefined;
  return row;
}

/** 读取当前 schema 版本；表不存在（全新库 / 版本化之前的库）返回 0。 */
function readSchemaVersion(): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const row = db.prepare(`SELECT version FROM schema_meta WHERE singleton = 1`).get() as
    | { version: number }
    | undefined;
  return row ? row.version : 0;
}

function writeSchemaVersion(version: number): void {
  db.prepare(
    `INSERT INTO schema_meta(singleton, version, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`
  ).run(version, new Date().toISOString());
}

/**
 * 应用所有版本大于当前记录的迁移。
 * 每个迁移单独包事务：一个失败不会让前面的白跑，也不会留下半截状态。
 */
function runMigrations(): void {
  const from = readSchemaVersion();
  if (from >= SCHEMA_VERSION) return;

  console.log(`[DB] schema 版本 ${from} → ${SCHEMA_VERSION}，开始迁移`);
  // 按版本号排序后再跑 —— 不依赖数组的书写顺序，防止新增迁移插错位置
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= from) continue;
    try {
      db.transaction(() => m.up())();
      writeSchemaVersion(m.version);
      console.log(`[DB] ✓ v${m.version} ${m.description}`);
    } catch (e) {
      // 迁移失败不直接退出进程：让看板仍能启动，由使用者在日志里看到原因。
      // 版本号停在失败前一版，下次启动会重试（因此 up() 必须幂等）。
      console.error(`[DB] ✗ v${m.version} 迁移失败（版本停在 ${readSchemaVersion()}）:`, e);
      return;
    }
  }
}

runMigrations();

// 类型定义
export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  created_at: string;
  tool_calls: string | null;
}

// ============= 看板类型定义 =============

/**
 * 任务**生命周期**状态 —— 决定任务「还活着没有」，不描述执行细节。
 *
 * 看板四列由此派生（见 `boardColumnOf`）：
 *   待办 = todo ／ 自动化定时 = scheduled
 *   进行中 / 待决策 = in_progress（由 run_state 再细分）
 *
 * ⚠️ 之所以把「等授权」「等额度」这类细节**移出** status：
 * 它们不是生命周期，而是**执行阶段**。混在一起会让
 * 「在跑，但当前卡在等授权」这种复合状态无法表达，
 * 也会让每个新增的等待类型都去污染 status 与看板列。
 */
export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'scheduled'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * **执行阶段** —— 仅当 `status === 'in_progress'` 时有意义，其余情况为 null。
 *
 * 与 status 的分工：
 *   status     回答「这个任务处在生命周期的哪一步」
 *   run_state  回答「它现在具体在干什么 / 卡在哪」
 */
export type TaskRunState =
  | 'starting'          // 已置为进行中，尚未拿到宿主 job
  | 'running'           // 正常执行中
  | 'waiting_approval'  // 等待人工授权 / 决策（原 pending_decision）
  | 'waiting_quota'     // 等待额度恢复（预留，尚未产生）
  | 'waiting_input'     // 等待用户补充输入（预留）
  | 'uncertain';        // 结果不确定，保留占用待核对（配合 wait_reason）

/**
 * 「有意停住、等人或等条件」的 run_state 集合 —— **唯一真源**。
 *
 * ⚠️ 为什么必须集中定义（2026-09-15 踩坑）：两层状态机改造后，
 * 「待决策」不再是独立 status，而是 `status='in_progress' + run_state='waiting_approval'`。
 * 于是所有写于旧模型时代的守卫 `if (task.status === 'in_progress') → 409` 都会
 * **把"待决策"也当成"正在跑"而拒绝操作** —— 用户报「点了『移回待办』没反应」即此因。
 *
 * 这些状态的特点是：**执行器已按设计退出，没有执行句柄** ⇒
 * 对它做「移回待办 / 删除」是安全的（不会留下野进程），应当放行。
 */
export const PARKED_RUN_STATES: ReadonlyArray<TaskRunState> = [
  'waiting_approval',
  'waiting_quota',
  'waiting_input',
  'uncertain',
];

/** 任务是否处于「有意停住」状态（可与 `status==='in_progress'` 组合判定） */
export function isParkedTask(task: {
  status: TaskStatus;
  run_state?: TaskRunState | null;
}): boolean {
  return task.status === 'in_progress' && PARKED_RUN_STATES.includes(task.run_state as TaskRunState);
}

/**
 * 看板列。由 (status, run_state) 派生，是**前端展示层**的概念。
 * 保留四列语义不变：待办 / 进行中 / 待决策 / 自动化定时。
 */
export type BoardColumn = 'todo' | 'running' | 'pending_decision' | 'scheduled';

/** 由 (status, run_state) 推断看板列。前后端共用同一份规则，避免两边漂移。 */
export function boardColumnOf(
  status: TaskStatus,
  runState: TaskRunState | null | undefined
): BoardColumn | null {
  switch (status) {
    case 'todo':
      return 'todo';
    case 'scheduled':
      return 'scheduled';
    case 'in_progress':
      return runState === 'waiting_approval' ? 'pending_decision' : 'running';
    default:
      // done / failed / cancelled：不属于四列中的任何一列（由调用方决定如何展示）
      return null;
  }
}

/** 任务是否处于「活跃」状态（占用调度槽位） */
export function isActiveStatus(status: TaskStatus): boolean {
  return status === 'in_progress';
}

/** 是否在等待人工授权 / 决策 */
export function isAwaitingApproval(
  status: TaskStatus,
  runState: TaskRunState | null | undefined
): boolean {
  return status === 'in_progress' && runState === 'waiting_approval';
}

/** 是否是终态 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

export interface DbWorkspace {
  id: string;
  name: string;
  path: string;
  max_concurrency: number;
  description: string | null;
  color: string | null;
  created_at: string;
}

/**
 * 任务执行者。'workbuddy'（派发给 WorkBuddy 宿主）已下线，见 `内部归档`
 * ⇒ 新建任务只会是 `'local'`。
 *
 * ⚠️ 历史数据里仍可能存在 `'workbuddy'` 字面值；调度器已不再按 executor 分支，
 * 一律走本地执行器，读旧数据不会出错。
 */
export type TaskExecutor = 'local';

/**
 * 隔离模式。
 * - `shared`  ：直接在工作空间目录里改（默认）。配合工作空间互锁，同空间任务串行，
 *               好处是成果就在用户自己的工作目录里。
 * - `worktree`：⚠️ **当前不可用**。原实现（`已归档的独立工作树模块`）只有已下线的 CLI 派发通道
 *               用过，模块已归档到 `内部归档`；
 *               `POST /api/tasks` 对 `isolation: 'worktree'` 直接返回 400，不会静默降级。
 *
 * ⚠️ 类型里保留 `'worktree'` 是为了**如实读取历史数据**，不代表仍可使用。
 */
export type TaskIsolation = 'shared' | 'worktree';

export interface DbTask {
  id: string;
  title: string;
  prompt: string;
  workspace_id: string | null;
  model: string;
  agent_id: string | null;
  status: TaskStatus;
  priority: number;
  scheduled_at: string | null;
  depends_on: string | null;
  decision_prompt: string | null;
  decision_options: string | null;
  decision_answer: string | null;
  session_id: string | null;
  sdk_session_id: string | null;
  result: string | null;
  error: string | null;
  progress_log: string | null;
  retry_count: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** 由谁执行（现只有 'local'；历史数据里可能是已下线的 'workbuddy'） */
  executor: TaskExecutor;
  /** 派发给 WorkBuddy 后对应的宿主 session id（用于回读执行状态） */
  host_session_id: string | null;
  /** 宿主 job id（官方 reply / stop 端点需要它，不能靠 sessionId 反推） */
  host_job_id: string | null;
  /** 隔离模式（默认 shared） */
  isolation: TaskIsolation;
  /** 隔离模式生效时，CLI 实际创建的工作树路径（回填展示） */
  worktree_path: string | null;
  /** 非空 = 有意保留占用并等待核对（表达「不确定」状态，而非正常执行中） */
  wait_reason: string | null;
  /** 执行阶段；仅 status=in_progress 时有意义，其余为 null */
  run_state: TaskRunState | null;
  /**
   * 声明的修改范围（JSON 数组，仓库内相对路径）。
   * 空数组 = 未声明，不参与冲突判定。
   */
  scopes: string | null;
  /**
   * 定期循环模式：'none'（默认，跑完就结束）/ 'periodic'（每天·每周·每月固定时刻）
   * / 'interval'（每 N 分钟·小时·天）。规格与算法见 `server/repeat.ts`。
   * ⚠️ 只作用于**看板自己新建的任务**；宿主定时任务仍只读。
   */
  repeat_mode: string;
  /** 循环规格（JSON，形状见 `RepeatSpec`）。mode='none' 时为 null */
  repeat_spec: string | null;
  /** 循环截止时间（ISO，含端点）。null = 一直循环（直到手动暂停/删除） */
  repeat_until: string | null;
  /** 最多执行多少轮。null = 不限 */
  repeat_limit: number | null;
  /** 已执行轮次（每轮结束时 +1；用于「已 N/M 次」展示与上限判定） */
  repeat_count: number;
  /** 暂停开关：1 = 不再被调度器触发（仍保留在「自动化定时」列，可随时恢复） */
  repeat_paused: number;
  /** 上一轮的实际结束时间（ISO），便于排查"间隔从何时起算" */
  repeat_last_at: string | null;
}

// ============= 会话操作 =============

// 获取所有会话
export function getAllSessions(): DbSession[] {
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
  return stmt.all() as DbSession[];
}

// 获取单个会话
export function getSession(id: string): DbSession | undefined {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(id) as DbSession | undefined;
}

// 创建会话
export function createSession(session: DbSession): DbSession {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, title, model, sdk_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(session.id, session.title, session.model, session.sdk_session_id, session.created_at, session.updated_at);
  return session;
}

// 更新会话
export function updateSession(id: string, updates: Partial<Pick<DbSession, 'title' | 'model' | 'sdk_session_id'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.sdk_session_id !== undefined) {
    fields.push('sdk_session_id = ?');
    values.push(updates.sdk_session_id);
  }
  
  if (fields.length === 0) return false;
  
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  
  const stmt = db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

// 删除会话
export function deleteSession(id: string): boolean {
  const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============= 消息操作 =============

// 获取会话的所有消息
export function getMessagesBySession(sessionId: string): DbMessage[] {
  const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
  return stmt.all(sessionId) as DbMessage[];
}

// 创建消息
export function createMessage(message: DbMessage): DbMessage {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    message.id,
    message.session_id,
    message.role,
    message.content,
    message.model,
    message.created_at,
    message.tool_calls
  );
  
  // 更新会话的 updated_at
  const updateStmt = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
  updateStmt.run(new Date().toISOString(), message.session_id);
  
  return message;
}

// 更新消息内容
export function updateMessage(id: string, updates: Partial<Pick<DbMessage, 'content' | 'tool_calls'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }
  if (updates.tool_calls !== undefined) {
    fields.push('tool_calls = ?');
    values.push(updates.tool_calls);
  }
  
  if (fields.length === 0) return false;
  
  values.push(id);
  
  const stmt = db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

// 删除消息
export function deleteMessage(id: string): boolean {
  const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// 批量创建消息（用于保存对话）
export function createMessages(messages: DbMessage[]): void {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((msgs: DbMessage[]) => {
    for (const msg of msgs) {
      stmt.run(msg.id, msg.session_id, msg.role, msg.content, msg.model, msg.created_at, msg.tool_calls);
    }
  });
  
  insertMany(messages);
}

// 清空所有数据
export function clearAllData(): void {
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM tasks');
  db.exec('DELETE FROM workspaces');
}

// ============= 工作空间操作 =============

export function getAllWorkspaces(): DbWorkspace[] {
  const stmt = db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC');
  return stmt.all() as DbWorkspace[];
}

export function getWorkspace(id: string): DbWorkspace | undefined {
  const stmt = db.prepare('SELECT * FROM workspaces WHERE id = ?');
  return stmt.get(id) as DbWorkspace | undefined;
}

/**
 * 创建工作空间。
 *
 * ⚠️ **同一路径只允许一个工作空间**（`workspaces.path` 上有 lower(path) 唯一索引）：
 * 同路径两个 id 等于两条互锁键 → 同一个目录能被并行改（见 v6 迁移注释）。
 * 因此这里做成**幂等**：路径已存在时直接返回既有那条，由调用方决定怎么提示。
 */
export function createWorkspace(ws: DbWorkspace): { workspace: DbWorkspace; deduped: boolean } {
  const existing = findWorkspaceByPath(ws.path);
  if (existing) return { workspace: existing, deduped: true };

  const stmt = db.prepare(`
    INSERT INTO workspaces (id, name, path, max_concurrency, description, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(ws.id, ws.name, ws.path, ws.max_concurrency, ws.description, ws.color, ws.created_at);
  return { workspace: ws, deduped: false };
}

export function updateWorkspace(
  id: string,
  updates: Partial<Pick<DbWorkspace, 'name' | 'path' | 'max_concurrency' | 'description' | 'color'>>
): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.path !== undefined) { fields.push('path = ?'); values.push(updates.path); }
  if (updates.max_concurrency !== undefined) { fields.push('max_concurrency = ?'); values.push(updates.max_concurrency); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }

  if (fields.length === 0) return false;

  values.push(id);
  const stmt = db.prepare(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`);
  return stmt.run(...values).changes > 0;
}

export function deleteWorkspace(id: string): boolean {
  const stmt = db.prepare('DELETE FROM workspaces WHERE id = ?');
  return stmt.run(id).changes > 0;
}

/**
 * **原子地**「把任务改挂到另一个空间 + 删除原空间」。
 *
 * 🔴 2026-09-16 加（审计 M3）：`workspaceSync.applyWorkspaceSync` 原先依次调用
 *    `reassignTasksWorkspace(...)` 再 `deleteWorkspace(...)` —— **两次独立调用**。
 *    中途抛错（库被锁、磁盘满、进程被杀）就会留下半成品：
 *    **任务已经改挂走了，原空间却还留着** —— 用户看到空间还在、里面却空了，
 *    而任务已经悄悄挂到别的空间名下，全程没有任何提示。
 *
 *    这两步语义上必须同生共死，所以包进一个事务。
 *
 * @returns `reassigned` 改挂的任务数；`deleted` 原空间是否真的被删掉
 */
export function reassignAndDeleteWorkspace(
  fromId: string,
  toId: string
): { reassigned: number; deleted: boolean } {
  const tx = db.transaction((from: string, to: string) => {
    const reassigned = reassignTasksWorkspace(from, to);
    const deleted = deleteWorkspace(from);
    return { reassigned, deleted };
  });
  return tx(fromId, toId) as { reassigned: number; deleted: boolean };
}

// ============= 任务操作 =============

export function getAllTasks(): DbTask[] {
  const stmt = db.prepare('SELECT * FROM tasks ORDER BY sort_order ASC, created_at ASC');
  return stmt.all() as DbTask[];
}

export function getTask(id: string): DbTask | undefined {
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  return stmt.get(id) as DbTask | undefined;
}

export function getTasksByStatus(status: TaskStatus): DbTask[] {
  const stmt = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY sort_order ASC, created_at ASC');
  return stmt.all(status) as DbTask[];
}

export function createTask(task: DbTask): DbTask {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, title, prompt, workspace_id, model, agent_id, status, priority,
      scheduled_at, depends_on, decision_prompt, decision_options, decision_answer,
      session_id, sdk_session_id, result, error, progress_log, retry_count, sort_order,
      created_at, updated_at, started_at, finished_at, executor, host_session_id,
      isolation, worktree_path, scopes,
      repeat_mode, repeat_spec, repeat_until, repeat_limit, repeat_count, repeat_paused, repeat_last_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    task.id, task.title, task.prompt, task.workspace_id, task.model, task.agent_id,
    task.status, task.priority, task.scheduled_at, task.depends_on,
    task.decision_prompt, task.decision_options, task.decision_answer,
    task.session_id, task.sdk_session_id, task.result, task.error, task.progress_log,
    task.retry_count, task.sort_order,
    task.created_at, task.updated_at, task.started_at, task.finished_at,
    task.executor ?? 'local', task.host_session_id ?? null,
    task.isolation ?? 'shared', task.worktree_path ?? null,
    // ⚠️ 漏掉这一项会让 scopes 静默丢失：建任务的响应是拿**内存对象**序列化的，
    // 接口看起来"存进去了"，实际没落库，范围约束就永远不会触发。
    task.scopes ?? null,
    // ⚠️ 同理：循环字段漏写不会报错，但任务会"看着是循环、实际只跑一次"
    task.repeat_mode ?? 'none', task.repeat_spec ?? null, task.repeat_until ?? null,
    task.repeat_limit ?? null, task.repeat_count ?? 0, task.repeat_paused ?? 0,
    task.repeat_last_at ?? null
  );
  return task;
}

/** 任务可更新的字段集合 */
export type TaskUpdatableFields = Pick<DbTask,
  | 'title' | 'prompt' | 'workspace_id' | 'model' | 'agent_id' | 'status' | 'priority'
  | 'scheduled_at' | 'depends_on' | 'decision_prompt' | 'decision_options' | 'decision_answer'
  | 'session_id' | 'sdk_session_id' | 'result' | 'error' | 'progress_log' | 'retry_count'
  | 'sort_order' | 'started_at' | 'finished_at' | 'executor' | 'host_session_id' | 'host_job_id'
  | 'isolation' | 'worktree_path' | 'wait_reason' | 'run_state' | 'scopes'
  | 'repeat_mode' | 'repeat_spec' | 'repeat_until' | 'repeat_limit' | 'repeat_count'
  | 'repeat_paused' | 'repeat_last_at'
>;

export function updateTask(id: string, updates: Partial<TaskUpdatableFields>): boolean {
  /**
   * 护栏：`run_state` / `wait_reason` 只在 `in_progress` 时有意义。
   *
   * 若调用方把状态改成别的（todo / scheduled / 终态）却没顺手清掉这两个字段，
   * 就会留下「已完成但仍在等授权」这类**非法组合**。
   * 本项目已在多处踩过这个坑（取消任务时漏清 run_state），
   * 与其要求每个入口各写一遍，不如在这里一次性兜住。
   */
  if (updates.status !== undefined && updates.status !== 'in_progress') {
    updates = { ...updates, run_state: null, wait_reason: null };
  }

  const fields: string[] = [];
  const values: any[] = [];

  const push = (col: string, val: any) => { fields.push(`${col} = ?`); values.push(val); };

  if (updates.title !== undefined) push('title', updates.title);
  if (updates.prompt !== undefined) push('prompt', updates.prompt);
  if (updates.workspace_id !== undefined) push('workspace_id', updates.workspace_id);
  if (updates.model !== undefined) push('model', updates.model);
  if (updates.agent_id !== undefined) push('agent_id', updates.agent_id);
  if (updates.status !== undefined) push('status', updates.status);
  if (updates.priority !== undefined) push('priority', updates.priority);
  if (updates.scheduled_at !== undefined) push('scheduled_at', updates.scheduled_at);
  if (updates.depends_on !== undefined) push('depends_on', updates.depends_on);
  if (updates.decision_prompt !== undefined) push('decision_prompt', updates.decision_prompt);
  if (updates.decision_options !== undefined) push('decision_options', updates.decision_options);
  if (updates.decision_answer !== undefined) push('decision_answer', updates.decision_answer);
  if (updates.session_id !== undefined) push('session_id', updates.session_id);
  if (updates.sdk_session_id !== undefined) push('sdk_session_id', updates.sdk_session_id);
  if (updates.result !== undefined) push('result', updates.result);
  if (updates.error !== undefined) push('error', updates.error);
  if (updates.progress_log !== undefined) push('progress_log', updates.progress_log);
  if (updates.retry_count !== undefined) push('retry_count', updates.retry_count);
  if (updates.sort_order !== undefined) push('sort_order', updates.sort_order);
  if (updates.started_at !== undefined) push('started_at', updates.started_at);
  if (updates.finished_at !== undefined) push('finished_at', updates.finished_at);
  if (updates.executor !== undefined) push('executor', updates.executor);
  if (updates.host_session_id !== undefined) push('host_session_id', updates.host_session_id);
  if (updates.host_job_id !== undefined) push('host_job_id', updates.host_job_id);
  if (updates.isolation !== undefined) push('isolation', updates.isolation);
  if (updates.worktree_path !== undefined) push('worktree_path', updates.worktree_path);
  if (updates.wait_reason !== undefined) push('wait_reason', updates.wait_reason);
  if (updates.run_state !== undefined) push('run_state', updates.run_state);
  if (updates.scopes !== undefined) push('scopes', updates.scopes);
  if (updates.repeat_mode !== undefined) push('repeat_mode', updates.repeat_mode);
  if (updates.repeat_spec !== undefined) push('repeat_spec', updates.repeat_spec);
  if (updates.repeat_until !== undefined) push('repeat_until', updates.repeat_until);
  if (updates.repeat_limit !== undefined) push('repeat_limit', updates.repeat_limit);
  if (updates.repeat_count !== undefined) push('repeat_count', updates.repeat_count);
  if (updates.repeat_paused !== undefined) push('repeat_paused', updates.repeat_paused);
  if (updates.repeat_last_at !== undefined) push('repeat_last_at', updates.repeat_last_at);

  if (fields.length === 0) return false;

  push('updated_at', new Date().toISOString());
  values.push(id);

  const stmt = db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`);
  const changed = stmt.run(...values).changes > 0;

  // ---------------------------------------------------------------------
  // 同步执行历史（task_runs）
  //
  // 挂在唯一的写入口上，而不是让每个调度路径各自记得写 run ——
  // 那是「N 个调用点共同维持一个不变式」，漏一个就丢历史。
  //   ① run_state 变化 → 更新当前**未结束**的那条 run
  //   ② 任务进入终态 → 给该 run 收尾（填 finished_at / result / error）
  // ---------------------------------------------------------------------
  if (changed && (updates.run_state !== undefined || updates.status !== undefined)) {
    const open = db
      .prepare(
        `SELECT id FROM task_runs
          WHERE task_id = ? AND finished_at IS NULL
          ORDER BY started_at DESC LIMIT 1`
      )
      .get(id) as { id: string } | undefined;

    if (open) {
      const now = new Date().toISOString();
      /**
       * 这次 run 是否应当在本轮更新里**收尾**。
       *
       * 🔴 2026-09-16 修（审计 M6）：原先只判 `isTerminalStatus`（done/failed/cancelled），
       *    于是 **`in_progress → todo` 这条回退路径**（孤儿回收、`/tasks/:id/to-todo`、
       *    决策回退）**不会关掉已开启的 run** ⇒ 该 run 永远 `finished_at = NULL`，
       *    执行历史里不断堆积「永不完结的一次执行」。
       *
       *    正确语义：**一次 run = 一次执行**。只要任务**不再是 `in_progress`**，
       *    这次执行就结束了 —— 无论它是正常终态，还是被回退到 todo / scheduled。
       *    （`status` 未传、或仍为 `in_progress` ⇒ 只是阶段变化，不收尾。）
       */
      const leavingRunning = updates.status !== undefined && updates.status !== 'in_progress';
      const setParts: string[] = ['updated_at = ?'];
      const vals: unknown[] = [now];

      // ⚠️ 只在 run_state **非空**时写入。
      // 任务进终态时 updateTask 会把 run_state 置为 null（见上方护栏），
      // 而 task_runs.run_state 是 NOT NULL —— 直接写 null 会抛
      // SQLITE_CONSTRAINT_NOTNULL 把进程打挂（踩过）。
      // 语义上也应该保留最后一个有意义的阶段：run 的收尾由 finished_at 表达。
      if (updates.run_state !== undefined && updates.run_state !== null) {
        setParts.push('run_state = ?');
        vals.push(updates.run_state);
      }
      if (updates.result !== undefined) {
        setParts.push('result = ?');
        vals.push(updates.result);
      }
      if (updates.error !== undefined) {
        setParts.push('structured_error = ?');
        vals.push(updates.error);
      }
      if (updates.worktree_path !== undefined) {
        setParts.push('worktree_path = ?');
        vals.push(updates.worktree_path);
      }
      if (updates.host_job_id !== undefined) {
        setParts.push('host_job_id = ?');
        vals.push(updates.host_job_id);
      }
      if (leavingRunning) {
        setParts.push('finished_at = ?');
        vals.push(now);
      }

      vals.push(open.id);
      db.prepare(`UPDATE task_runs SET ${setParts.join(', ')} WHERE id = ?`).run(...vals);
    }
  }

  return changed;
}

/**
 * 幂等修复：把「任务早已离开 `in_progress`、但 run 仍然开着」的历史遗留收尾。
 *
 * 🔴 2026-09-16 加（审计 M6 的收尾）。原因见 `updateTask` 里 `leavingRunning` 的注释：
 *    在此之前 `in_progress → todo` 这条回退路径**不会关 run**，而留下的
 *    `finished_at = NULL` **不会自行消失** —— 任务状态不再变化，就再也没有机会触发收尾。
 *    所以要在启动时补一次。
 *
 * 收尾时间取该任务的 `finished_at`，取不到就退到 run 自己的 `updated_at`。
 * **完全幂等**：只补 `finished_at IS NULL` 的行，重复执行不会改动任何数据。
 *
 * @returns 实际修复的 run 条数（供启动日志展示）
 */
export function repairDanglingRuns(): number {
  const stmt = db.prepare(`
    UPDATE task_runs
       SET finished_at = COALESCE(
             (SELECT t.finished_at FROM tasks t WHERE t.id = task_runs.task_id),
             updated_at
           )
     WHERE finished_at IS NULL
       AND task_id IN (SELECT id FROM tasks WHERE status <> 'in_progress')
  `);
  return stmt.run().changes;
}

export function deleteTask(id: string): boolean {
  // task_dependencies 有 ON DELETE CASCADE，外键开启后会自动清理。
  // 但外键开关是**连接级**的，为防万一这里显式清一次（幂等、代价可忽略）。
  db.prepare('DELETE FROM task_dependencies WHERE blocker_task_id = ? OR blocked_task_id = ?').run(id, id);
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  return stmt.run(id).changes > 0;
}

// ============= 执行历史（task_runs） =============

export interface DbTaskRun {
  id: string;
  task_id: string;
  run_state: string;
  host_job_id: string | null;
  host_session_id: string | null;
  worktree_path: string | null;
  result: string | null;
  structured_error: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

interface TaskRunRow {
  id: string;
  task_id: string;
  run_state: string;
  host_job_id: string | null;
  host_session_id: string | null;
  worktree_path: string | null;
  result: string | null;
  structured_error: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

function rowToTaskRun(row: TaskRunRow): DbTaskRun {
  return { ...row };
}

/** 开始一次执行：写入一条 run 记录，返回其 id（后续用它更新同一条） */
export function createTaskRun(input: {
  taskId: string;
  runState: string;
  hostJobId?: string | null;
  hostSessionId?: string | null;
  worktreePath?: string | null;
}): DbTaskRun {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, run_state, host_job_id, host_session_id, worktree_path,
        result, structured_error, started_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`
  ).run(
    id,
    input.taskId,
    input.runState,
    input.hostJobId ?? null,
    input.hostSessionId ?? null,
    input.worktreePath ?? null,
    now,
    now
  );
  return getTaskRun(id)!;
}

export function getTaskRun(id: string): DbTaskRun | undefined {
  const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as TaskRunRow | undefined;
  return row ? rowToTaskRun(row) : undefined;
}

/** 更新某次执行的记录（只传需要改的字段） */
export function updateTaskRun(
  id: string,
  updates: Partial<Pick<DbTaskRun, 'run_state' | 'host_job_id' | 'host_session_id' | 'worktree_path' | 'result' | 'structured_error' | 'finished_at'>>
): DbTaskRun | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return getTaskRun(id);

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE task_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTaskRun(id);
}

/** 某任务的全部执行历史，最新在前 */
export function listTaskRuns(taskId: string): DbTaskRun[] {
  return (
    db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId) as TaskRunRow[]
  ).map(rowToTaskRun);
}

// ============= 任务依赖 =============

/** 读取某任务的前置任务 id 列表（blocker） */
export function getDependencies(taskId: string): string[] {
  const rows = db
    .prepare('SELECT blocker_task_id FROM task_dependencies WHERE blocked_task_id = ?')
    .all(taskId) as Array<{ blocker_task_id: string }>;
  return rows.map(r => r.blocker_task_id);
}

/** 解析某任务声明的修改范围（容错：坏 JSON 返回空数组） */
export function getScopes(taskId: string): string[] {
  const row = db.prepare('SELECT scopes FROM tasks WHERE id = ?').get(taskId) as
    | { scopes: string | null }
    | undefined;
  if (!row?.scopes) return [];
  try {
    const parsed = JSON.parse(row.scopes);
    return Array.isArray(parsed) ? parsed.filter((p: unknown): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** 反查：谁依赖了这个任务 */
export function getDependents(taskId: string): string[] {
  const rows = db
    .prepare('SELECT blocked_task_id FROM task_dependencies WHERE blocker_task_id = ?')
    .all(taskId) as Array<{ blocked_task_id: string }>;
  return rows.map(r => r.blocked_task_id);
}

/**
 * 覆写某任务的前置列表（先删后插），并做校验：
 *   - 丢弃自环与空值
 *   - 丢弃不存在的任务 id（join 表有外键，留着会插失败）
 *   - **环路检测**：若新依赖会形成环，整体拒绝并抛错
 * @returns 实际写入的数量
 */
export function setDependencies(taskId: string, blockerIds: string[]): number {
  const clean = [...new Set(
    (blockerIds || []).filter(id => typeof id === 'string' && id && id !== taskId)
  )];
  const valid = clean.filter(id => db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id));

  // 环路检测：从候选 blocker 出发沿「它依赖谁」向上走，若能走到 taskId 即成环
  const wouldCycle = (start: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of getDependencies(cur)) stack.push(next);
    }
    return false;
  };
  for (const id of valid) {
    if (wouldCycle(id)) throw new Error(`依赖会形成环：${taskId} → ${id}`);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM task_dependencies WHERE blocked_task_id = ?').run(taskId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO task_dependencies(blocker_task_id, blocked_task_id, created_at) VALUES (?, ?, ?)'
    );
    const now = new Date().toISOString();
    for (const id of valid) insert.run(id, taskId, now);
  })();

  return valid.length;
}

/** 统计某工作空间下处于指定状态之一的任务数量（调度互锁判定用） */
export function countTasksInWorkspace(
  workspaceId: string,
  statuses: TaskStatus[],
  /**
   * 只统计某种隔离模式的任务。
   * - 传 `'shared'`：仅就地执行的任务 —— 它们才真正争抢同一份工作目录，
   *   所以工作空间互锁只应约束它们。
   * - 不传：统计全部（工作空间占用判定等场景需要完整视图）。
   */
  isolation?: TaskIsolation
): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => '?').join(', ');
  const isoClause = isolation ? ' AND isolation = ?' : '';
  const stmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM tasks WHERE workspace_id = ? AND status IN (${placeholders})${isoClause}`
  );
  const args: unknown[] = [workspaceId, ...statuses];
  if (isolation) args.push(isolation);
  const row = stmt.get(...args) as { cnt: number };
  return row.cnt;
}

/** 统计全局处于指定状态之一的任务数量（资源槽位判定用） */
export function countTasksByStatuses(statuses: TaskStatus[]): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => '?').join(', ');
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE status IN (${placeholders})`);
  const row = stmt.get(...statuses) as { cnt: number };
  return row.cnt;
}

/**
 * 统计**真正在跑**的任务数（`in_progress` 且**不在等人**）—— 槽位占用要用这个。
 *
 * 🔴 2026-09-16 加（审计 M5）。原先槽位判定用的是 `countTasksByStatuses(['in_progress'])`，
 *    而「等人工授权」的任务 status **仍然是 `in_progress`**（只是 `run_state='waiting_approval'`），
 *    于是它们照样占着整机槽位 ⇒ 几个任务同时卡在等授权时，`scheduler` 会在
 *    「整机占用已满」那一处直接 return —— **没有实际并发，却整个停摆**。
 *
 *    宿主侧本来就是「只算 `working`、**不算 `pending`**」（见 hostOccupancy.ts：
 *    pending 是"等人回答，没有在消耗机器"）⇒ 两侧口径原本不对称，这里对齐到宿主侧。
 *
 * ⚠️ `run_state='uncertain'`（结果待核对）**仍然计入** —— 那时执行器状态未知、
 *    目录锁必须保持，不能当成"空闲"。
 */
export function countTasksRunningNow(): number {
  const stmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM tasks
      WHERE status = 'in_progress'
        AND (run_state IS NULL OR run_state <> 'waiting_approval')`
  );
  return (stmt.get() as { cnt: number }).cnt;
}

/** 查询所有已到触发时间的定时任务 */
export function getDueScheduledTasks(nowIso: string): DbTask[] {
  const stmt = db.prepare(
    `SELECT * FROM tasks WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`
  );
  return stmt.all(nowIso) as DbTask[];
}

// ============= 设置操作 =============

export function getSetting(key: string): string | undefined {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(key, value, new Date().toISOString());
}

export function getAllSettings(): Record<string, string> {
  const stmt = db.prepare('SELECT key, value FROM settings');
  const rows = stmt.all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

/** 读取全局并发上限（默认 3） */
export function getGlobalConcurrency(): number {
  const raw = getSetting('global_concurrency');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

// ===========================================================================
// 交互（interactions）—— 需要人工介入的请求
// ===========================================================================

/** 交互类型 */
export type InteractionKind =
  | 'permission'         // 宿主请求权限确认
  | 'permission_denied'  // 后台任务权限被自动拒绝，需用户决定是否授权重跑
  | 'decision'           // 本地执行器经 canUseTool 命中需人工决策
  | 'manual';            // 用户主动把任务挂起提问

export type InteractionStatus = 'pending' | 'resolved' | 'canceled';

export interface DbInteraction {
  id: string;
  task_id: string;
  kind: InteractionKind;
  /** 幂等键：同一 requestId 只会创建一条记录 */
  request_id: string;
  /** 业务载荷（JSON 字符串）：{ prompt, options } */
  payload: string;
  blocking_scope: string;
  status: InteractionStatus;
  /** 用户答复（JSON 字符串）：{ answer } */
  response: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InteractionPayload {
  prompt: string;
  options: string[];
}

interface InteractionRow {
  id: string;
  task_id: string;
  kind: string;
  request_id: string;
  payload: string;
  blocking_scope: string;
  status: string;
  response: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToInteraction(row: InteractionRow): DbInteraction {
  return {
    id: row.id,
    task_id: row.task_id,
    kind: row.kind as InteractionKind,
    request_id: row.request_id,
    payload: row.payload,
    blocking_scope: row.blocking_scope,
    status: row.status as InteractionStatus,
    response: row.response,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 解析交互载荷（容错：坏 JSON 返回 null） */
export function parseInteractionPayload(interaction: DbInteraction): InteractionPayload | null {
  try {
    const parsed = JSON.parse(interaction.payload);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      options: Array.isArray(parsed.options) ? parsed.options.filter((o: unknown) => typeof o === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** 解析交互答复文本 */
export function parseInteractionAnswer(interaction: DbInteraction): string | null {
  if (!interaction.response) return null;
  try {
    const parsed = JSON.parse(interaction.response);
    return typeof parsed?.answer === 'string' ? parsed.answer : null;
  } catch {
    return null;
  }
}

/**
 * 创建一条交互。**幂等**：`request_id` 已存在时直接返回已有记录，不重复创建。
 *
 * 幂等的必要性：调度器每 3 秒轮询一次宿主 job，同一段「权限被拒」的文案
 * 会被反复读到 —— 不去重就会反复建待决策。
 *
 * @returns 新建或已存在的记录
 */
export function createInteraction(input: {
  taskId: string;
  kind: InteractionKind;
  requestId: string;
  payload: InteractionPayload;
  blockingScope?: string;
}): { interaction: DbInteraction; created: boolean } {
  const existing = db
    .prepare(`SELECT * FROM interactions WHERE request_id = ?`)
    .get(input.requestId) as InteractionRow | undefined;
  if (existing) {
    return { interaction: rowToInteraction(existing), created: false };
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO interactions
       (id, task_id, kind, request_id, payload, blocking_scope, status, response, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, 1, ?, ?)`
  ).run(
    id,
    input.taskId,
    input.kind,
    input.requestId,
    JSON.stringify(input.payload),
    input.blockingScope ?? 'task',
    now,
    now
  );

  return {
    interaction: getInteraction(id)!,
    created: true,
  };
}

export function getInteraction(id: string): DbInteraction | undefined {
  const row = db.prepare(`SELECT * FROM interactions WHERE id = ?`).get(id) as InteractionRow | undefined;
  return row ? rowToInteraction(row) : undefined;
}

/** 某任务当前待处理的交互（最新的那条） */
export function getPendingInteraction(taskId: string): DbInteraction | undefined {
  const row = db
    .prepare(
      `SELECT * FROM interactions WHERE task_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(taskId) as InteractionRow | undefined;
  return row ? rowToInteraction(row) : undefined;
}

/** 某任务最近一次已答复的交互 */
export function getLatestResolvedInteraction(taskId: string): DbInteraction | undefined {
  const row = db
    .prepare(
      `SELECT * FROM interactions WHERE task_id = ? AND status = 'resolved'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(taskId) as InteractionRow | undefined;
  return row ? rowToInteraction(row) : undefined;
}

/** 某任务的全部交互（按时间倒序），用于历史展示 */
export function listInteractions(taskId: string, opts: { pendingOnly?: boolean } = {}): DbInteraction[] {
  const sql = opts.pendingOnly
    ? `SELECT * FROM interactions WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC`
    : `SELECT * FROM interactions WHERE task_id = ? ORDER BY created_at DESC`;
  return (db.prepare(sql).all(taskId) as InteractionRow[]).map(rowToInteraction);
}

/**
 * 答复一条交互。
 * 带**乐观锁**：`expectedVersion` 不匹配说明已被别人改过，返回 null 而不是覆盖。
 */
export function resolveInteraction(
  id: string,
  answer: string,
  expectedVersion?: number
): DbInteraction | null {
  const current = getInteraction(id);
  if (!current || current.status !== 'pending') return null;
  if (expectedVersion !== undefined && current.version !== expectedVersion) return null;

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE interactions
         SET status = 'resolved', response = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'pending' AND version = ?`
    )
    .run(JSON.stringify({ answer }), now, id, current.version);

  if (result.changes === 0) return null;
  return getInteraction(id) ?? null;
}

/**
 * 把某任务所有待处理交互标记为已取消。
 * 用于重试 / 移回待办 / 取消 —— 那些路径下旧的提问已经不作数了。
 */
export function cancelPendingInteractions(taskId: string): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE interactions
         SET status = 'canceled', version = version + 1, updated_at = ?
       WHERE task_id = ? AND status = 'pending'`
    )
    .run(now, taskId);
  return result.changes;
}

// ---------------------------------------------------------------------------
// 迁移：把 tasks 上遗留的决策列搬进 interactions
//
// 幂等：只处理「有待答复问题、但表里还没有对应交互」的任务。
// 迁移后旧列不再作为真源（读取走 serializeTask 的派生逻辑），
// 但物理列保留 —— 避免动 schema，也留一份原始痕迹。
// ---------------------------------------------------------------------------


export default db;
