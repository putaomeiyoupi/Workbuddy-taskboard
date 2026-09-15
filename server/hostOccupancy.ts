/**
 * 宿主（WorkBuddy）占用的执行槽位
 * ============================================================================
 * 用户诉求（2026-09-14）：
 *   「并发上限不光要看板本身的任务数量，还要看 WorkBuddy 在执行的任务数量。
 *     比如上限是 5、WorkBuddy 正在执行 3 个，那么看板只能执行 2 个。
 *     这是在一台电脑上，要通盘考虑。」
 *
 * 所以并发上限的语义从「看板自己的派发节奏」升级为**整机占用**：
 *   占用 = 看板在跑的任务 + 宿主在跑（且不是看板派发出去）的会话
 *
 * ⚠️ 去重是必须的：看板派发给 WorkBuddy 的任务在宿主侧也会留下一条 working 会话，
 * 若两边都算就会把同一个任务数成两个（实测会把 3 个任务显示成 6）。
 * 判据：看板任务的 `host_session_id` 命中该会话 → 已计入看板占用，不能再算一次。
 *
 * ⚠️ 只算 `working`，**不算 `pending`**：pending 是"等人回答"，没有在消耗机器。
 *
 * 🔴 2026-09-16（审计 M5）：**看板侧已对齐到同一口径** —— `boardRunning` 不再用
 *    「`in_progress` 的任务数」，而是「**真正在跑**的数」（排除 `run_state='waiting_approval'`）。
 *    两侧原先是**互相矛盾**的：宿主侧"等人不计"、看板侧"等人照计" ⇒
 *    几个任务同时卡在等授权就把整机槽位占满，**没有实际并发却停摆**。
 *
 * 本模块是唯一定义处 —— 调度器（真判定）与 `/api/scheduler/status`（展示）共用，
 * 避免"显示的数和真判定的数不一致"这类最招人烦的问题。
 */

import * as db from './db.js';
import * as hostAdapter from './hostAdapter.js';

export interface Occupancy {
  /** 看板调度器占用的槽位（= `in_progress` 且**不在等人**的任务数，见 `db.countTasksRunningNow`） */
  boardRunning: number;
  /** 宿主正在执行、且**不是**看板派发出去的会话数 */
  hostRunning: number;
  /** 本机实际占用合计 */
  total: number;
  /** 全局并发上限 */
  limit: number;
}

/** 宿主正在执行、且不属于看板派发的会话数 */
export function countHostRunning(): number {
  try {
    const owned = new Set(
      db
        .getAllTasks()
        .map(t => t.host_session_id)
        .filter((id): id is string => !!id)
    );
    return hostAdapter.getHostSessions(['working'], 80).filter(s => !owned.has(s.id)).length;
  } catch (err) {
    // 宿主库读不到不该影响调度：降级为"只看看板自己"
    console.warn('[Occupancy] 读取宿主在跑会话失败，按 0 计:', (err as Error)?.message ?? err);
    return 0;
  }
}

/**
 * 当前占用快照（调度判定与界面展示共用同一口径）
 *
 * 🔴 2026-09-16 改（审计 M5）：`boardRunning` 由「`in_progress` 的任务数」改为
 *    「**真正在跑**的任务数」—— 即**排除 `run_state='waiting_approval'`**（等人工授权）。
 *    等授权期间没有在消耗机器，这与本模块上方「只算 `working`、不算 `pending`」的
 *    宿主侧口径是**同一条道理**。
 */
export function getOccupancy(): Occupancy {
  const boardRunning = db.countTasksRunningNow();
  const hostRunning = countHostRunning();
  return {
    boardRunning,
    hostRunning,
    total: boardRunning + hostRunning,
    limit: db.getGlobalConcurrency(),
  };
}
