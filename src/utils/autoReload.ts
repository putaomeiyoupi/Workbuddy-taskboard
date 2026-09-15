/**
 * 长时运行自愈：定期重载页面
 * ============================================================================
 * 为什么需要它（2026-09-15，用户要求「7×24 长期显示」）：
 *
 *   浏览器渲染进程存在**与渲染负载相关的原生崩溃** —— 实测 Microsoft Edge 153
 *   在「大 DOM + 周期性整树重渲染」下约 35 秒报 `STATUS_ACCESS_VIOLATION`
 *   （零 JS 异常、DOM 节点数恒定、JS 堆稳定，所以从页面内部**看不到任何征兆**；
 *   同一页面在 Chromium 151 上完全正常）。
 *
 *   我们已经把"无意义的重渲染"从源头消掉（见 `hostSnapshotHash` 里的 `idleMs` 说明、
 *   以及 `refreshStatus` 的内容判重），但**任何长时间运行的 SPA 都会在浏览器侧累积状态**，
 *   而看板是要挂着不动的。定期重载是壁挂大屏的标准做法：
 *   代价是闪一下白，收益是**累积被定期清零**。
 *
 * 行为：
 *   - 间隔取自 `localStorage['kanban.autoReloadHours']`，**默认 6 小时**；填 `0` 关闭
 *   - 到点后若页面**不可见**（切走 / 锁屏）⇒ 立刻重载，完全无感；
 *     可见则也重载（大屏场景下一次短暂白屏可接受）
 *   - 页面隐藏期间若「距离下次重载不足 10 分钟」⇒ 借机提前重载（把白屏藏起来）
 *   - 用 sessionStorage 记时刻，刷新后重新计时，天然不会形成刷新死循环
 *
 * 运维用法（浏览器控制台执行，无需改代码）：
 *   kanbanAutoReload.setHours(12)   // 改成 12 小时；0 = 关闭
 *   kanbanAutoReload.status()       // 看剩余时间
 */

const HOURS_KEY = 'kanban.autoReloadHours';
const BUDGET_KEY = 'kanban.autoReloadBudget';
const ANCHOR_KEY = 'kanban.autoReloadAnchorAt';
const USED_KEY = 'kanban.autoReloadUsed';
/** 默认 6 小时：对 7×24 展示足够稳，又不会频繁闪屏 */
const DEFAULT_HOURS = 6;
/**
 * 默认"更新预算"：累计应用多少次**整树更新**（宿主快照）就重载一次。
 *
 * ⚠️ 这个 20 不是拍脑袋，是**实测反推**的：
 *   在 msedge 153 上用「每 3 秒注入一帧真实变化」压测同一页面 ——
 *     · 卡片 memo 化之前：约 **12 次**更新即崩（每次拖着几十张卡重渲染），35.5s
 *     · 卡片 memo 化之后：约 **49 次**更新才崩（每次只重渲染变了的那一张卡），156.6s
 *   ⇒ 取 49 的约 40% 作为预算（20），留足余量；达到即重载清零。
 *
 * 为什么用计数而不是纯时钟：变化频率**不可控**（取决于宿主里有多少 agent 在跑）。
 * 实测本机常态很稀疏（200 秒约 1 次），但忙碌时可能每 3 秒一次；
 * 纯时钟兜底在忙碌时会来不及，计数则无论快慢都在预算内清零。
 * 控制台可调：`localStorage.setItem('kanban.autoReloadBudget','50')`（0 = 关闭计数兜底）。
 */
const DEFAULT_BUDGET = 20;
/** 每次检查的间隔 */
const CHECK_EVERY_MS = 60_000;
/** 页面隐藏时，若距离下次重载已不足这么久，就借机提前重载（把白屏藏起来） */
const OPPORTUNISTIC_WINDOW_MS = 10 * 60_000;
/** 正在交互时推迟多久再试（别把用户正在填的表单刷掉） */
const DEFER_MS = 5 * 60_000;

function readSetting(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readCounter(): number {
  try {
    const n = Number(sessionStorage.getItem(USED_KEY) ?? '0');
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 记一次「整树更新已应用」（由 `useTasks` 在真正 `setHost` 之后调用）。
 *
 * ⚠️ 只在**真的更新了状态**时调用 —— 被指纹判重丢掉的帧不该计数，
 *    否则计数会把"其实没重渲染"也算进去，兜底会过早触发。
 */
export function countFullTreeUpdate(): void {
  const budget = readSetting(BUDGET_KEY, DEFAULT_BUDGET);
  if (!(budget > 0)) return; // 预算为 0 = 关闭计数兜底
  try {
    const next = readCounter() + 1;
    sessionStorage.setItem(USED_KEY, String(next));
    if (next >= budget && !pendingBudgetReload) {
      pendingBudgetReload = true;
      /**
       * ⚠️ 不能只等每 60 秒一次的常规检查 —— 那期间还会继续累积（最坏再叠加一个预算的量），
       *    把"预算 20"实际变成"最多 40 次才清零"，逼近实测极限（49 次）。
       *    所以预算一耗尽就**立刻排一次检查**（延迟 3 秒，避开当前这轮渲染）。
       *    方不方便刷新仍由 `check` 里的 isBusy() 决定。
       */
      window.setTimeout(checkNow!, 3000);
    }
  } catch {
    /* 忽略：退化为纯时间兜底 */
  }
}

/** 预算已耗尽、等待合适时机重载 */
let pendingBudgetReload = false;
/** 由 installAutoReload 注入，供"预算耗尽后立刻复查"使用 */
let checkNow: (() => void) | null = null;

/**
 * 元素是否**真的可见**。
 *
 * ⚠️ 不能只看"选择器能不能选中"：TDesign 的 `Dialog` / `Drawer` 即使 `visible=false`
 *    也会在 body 下留一个容器节点（`.t-dialog` / `.t-drawer`）。
 *    早先版本用 `querySelector('.t-dialog, .t-drawer')` 判断"有弹窗"，结果
 *    **页面上根本没有弹窗时也判成 busy ⇒ 自愈永远不触发**（实测：预算已耗尽却 0 次重载）。
 *    所以这里一律按 `display/visibility/尺寸` 判可见性。
 */
function isVisible(el: Element | null): boolean {
  if (!el) return false;
  const cs = window.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * 现在是否"不适合刷新"。
 *
 * 看板既是 7×24 大屏、也有人在用，所以要避开**正在输入**的瞬间：
 * 焦点在输入控件里、或有**可见的**弹窗/抽屉 ⇒ 推迟，不要把人填了一半的内容刷掉。
 */
function isBusy(): boolean {
  try {
    const el = document.activeElement as HTMLElement | null;
    if (el) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
        return true;
      }
    }
    for (const sel of ['[role="dialog"]', '.t-dialog', '.t-drawer', '.task-drawer']) {
      for (const node of Array.from(document.querySelectorAll(sel))) {
        if (isVisible(node)) return true;
      }
    }
  } catch {
    /* 取不到就当作不忙 */
  }
  return false;
}

function readHours(): number {
  try {
    const raw = localStorage.getItem(HOURS_KEY);
    if (raw === null) return DEFAULT_HOURS;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_HOURS;
  } catch {
    // 隐私模式/禁用存储时不要让整页崩掉 —— 退回默认值即可
    return DEFAULT_HOURS;
  }
}

function readAnchor(): number {
  try {
    const raw = sessionStorage.getItem(ANCHOR_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* 忽略 */
  }
  const now = Date.now();
  try {
    sessionStorage.setItem(ANCHOR_KEY, String(now));
  } catch {
    /* 忽略 */
  }
  return now;
}

/** 立即重载（并记录原因，便于事后从控制台回溯"为什么白了一下"） */
function reloadNow(reason: string): void {
  try {
    sessionStorage.setItem(ANCHOR_KEY, String(Date.now()));
    /**
     * 🔴 必须把预算计数**归零**。
     *
     * `sessionStorage` 是**跨刷新保留**的，而重载的目的正是"清零累积"。
     * 第一版忘了归零 ⇒ 重载后计数仍是 20+ ⇒ 下一条宿主快照立刻又超预算
     * ⇒ **每几秒重载一次的重载循环**（实测：t=62s、t=88s 各重载一次，且计数持续上涨 24→29）。
     * 重载即"新的一轮"，计数回到 0 才符合语义。
     */
    sessionStorage.setItem(USED_KEY, '0');
  } catch {
    /* 忽略 */
  }
  pendingBudgetReload = false;
  console.info(`[autoReload] ${reason} —— 重载页面以清零累积的浏览器侧状态`);
  location.reload();
}

export interface AutoReloadHandle {
  /** 当前生效的间隔（小时）；0 = 已关闭 */
  getHours: () => number;
  /** 设置间隔（小时）；0 = 关闭时间兜底（⚠️ 更新预算仍生效，要全关请用 disable()） */
  setHours: (h: number) => void;
  /** 彻底关闭两条兜底（时间 + 更新预算） */
  disable: () => void;
  /** 恢复两条兜底为默认值（6 小时 / 预算 20） */
  enable: () => void;
  /** 运行状态：剩余时间 + 更新预算用量，便于运维查看 */
  status: () => {
    enabled: boolean;
    hours: number;
    elapsedMin: number;
    remainingMin: number | null;
    updatesUsed: number;
    updateBudget: number;
  };
}

/**
 * 安装自愈定时器。**幂等**：重复调用只会保留一个定时器。
 */
export function installAutoReload(): void {
  const g = window as unknown as { __kanbanAutoReloadInstalled?: boolean; kanbanAutoReload?: AutoReloadHandle };
  if (g.__kanbanAutoReloadInstalled) return;
  g.__kanbanAutoReloadInstalled = true;

  const hours0 = readHours();
  // 关闭时不装定时器，但**仍然暴露 handle**，方便随时 setHours 打开
  const anchor = readAnchor();

  /** @returns 是否已到点 */
  const due = (): { isDue: boolean; remainingMs: number | null } => {
    const hours = readHours();
    if (!(hours > 0)) return { isDue: false, remainingMs: null };
    const elapsed = Date.now() - anchor;
    const left = hours * 3_600_000 - elapsed;
    return { isDue: left <= 0, remainingMs: left };
  };

  /** 第一次因"正在被使用"而推迟的时刻；用于防止自愈被无限期卡住 */
  let firstDeferAt = 0;

  const check = (): void => {
    const { isDue } = due();
    // 两条触发：① 到时间（兜底）② 更新预算耗尽（自适应，忙碌时更早触发）
    if (!isDue && !pendingBudgetReload) return;
    // 正在输入/有可见弹窗 ⇒ 推迟，别打断人
    if (isBusy()) {
      const now = Date.now();
      if (!firstDeferAt) firstDeferAt = now;
      // ⚠️ 兜底不能被无限期推迟：累计推迟超过一个周期就强制重载。
      //    否则"页面上一直有个可见弹窗"会让自愈彻底失效，累积继续逼近崩溃点。
      if (now - firstDeferAt < DEFER_MS) {
        console.info('[autoReload] 该重载了但页面正在被使用，稍后重试');
        if (isDue) {
          try {
            sessionStorage.setItem(
              ANCHOR_KEY,
              String(Date.now() - (readHours() * 3_600_000 - DEFER_MS))
            );
          } catch {
            /* 忽略 */
          }
        }
        return;
      }
      console.info('[autoReload] 已推迟超过 5 分钟，为保护页面强制重载');
    }
    reloadNow(
      pendingBudgetReload
        ? `已应用约 ${readCounter()} 次更新（达到预算）`
        : `已连续运行约 ${readHours()} 小时`
    );
  };

  // 页面隐藏时：若快要到点了（或预算已耗尽），就趁看不见的时候把白屏藏掉
  const onVisibility = (): void => {
    if (document.visibilityState !== 'hidden') {
      check();
      return;
    }
    const { isDue, remainingMs } = due();
    if (pendingBudgetReload) {
      reloadNow(`已应用约 ${readCounter()} 次更新（达到预算），页面已隐藏`);
      return;
    }
    if (isDue || (remainingMs !== null && remainingMs <= OPPORTUNISTIC_WINDOW_MS)) {
      reloadNow(isDue ? '已到定期重载时间' : '页面已隐藏，提前完成定期重载');
    }
  };

  const budget0 = readSetting(BUDGET_KEY, DEFAULT_BUDGET);
  // 供 countFullTreeUpdate 在预算耗尽后立刻复查（见那里的说明）
  checkNow = check;
  // 时间兜底与预算兜底**任一开启**就要装定时器；都关掉时只暴露 handle
  if (hours0 > 0 || budget0 > 0) {
    window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisibility);
    // 启动时先判一次：标签页被后台恢复/机器休眠很久后再唤醒，也能立刻生效
    window.setTimeout(check, 3000);
  }

  g.kanbanAutoReload = {
    getHours: () => readHours(),
    setHours: (h: number) => {
      try {
        localStorage.setItem(HOURS_KEY, String(Number(h) || 0));
      } catch {
        /* 忽略 */
      }
      reloadNow(`已将自动重载间隔改为 ${h} 小时`);
    },
    /**
     * 彻底关闭两条兜底。⚠️ 单用 `setHours(0)` 只关时间兜底，更新预算仍会触发 ——
     * 所以专门给一个明确的"全关"，避免用户以为已经关了其实没有。
     */
    disable: () => {
      try {
        localStorage.setItem(HOURS_KEY, '0');
        localStorage.setItem(BUDGET_KEY, '0');
      } catch {
        /* 忽略 */
      }
      pendingBudgetReload = false;
      console.info('[autoReload] 已关闭（时间兜底 + 更新预算）');
    },
    /** 恢复为默认（6 小时 / 预算 20） */
    enable: () => {
      try {
        localStorage.setItem(HOURS_KEY, String(DEFAULT_HOURS));
        localStorage.setItem(BUDGET_KEY, String(DEFAULT_BUDGET));
      } catch {
        /* 忽略 */
      }
      reloadNow(`已恢复自动重载（${DEFAULT_HOURS} 小时 / 预算 ${DEFAULT_BUDGET} 次）`);
    },
    status: () => {
      const hours = readHours();
      const budget = readSetting(BUDGET_KEY, DEFAULT_BUDGET);
      const used = readCounter();
      const elapsedMin = Math.round((Date.now() - anchor) / 60_000);
      return {
        enabled: hours > 0 || budget > 0,
        hours,
        elapsedMin,
        remainingMin: hours > 0 ? Math.max(0, Math.round(hours * 60 - elapsedMin)) : null,
        updatesUsed: used,
        updateBudget: budget,
      };
    },
  };
}
