/**
 * 看板任务的「定期循环」规格（周期 / 间隔）
 * ============================================================================
 * 需求（用户 2026-09-15）：
 *   定时任务增加「任务定期循环」选项，分**周期**或**间隔**两种，参考 WorkBuddy 里的设定项。
 *   —— 只针对**看板自己新建的任务**；宿主（WorkBuddy）的自动化仍然只读。
 *
 * 为什么服务端是唯一真源：
 *   「下一次该在什么时候跑」必须只有一个算法。若前端也自己算一遍用于预览，
 *   一旦两边实现有细微差异（时区、月末溢出、跨周判定），就会出现
 *   「界面说 08:20、实际 09:20 才跑」这类无法复现的偏差。
 *   所以：**计算只在服务端做**，前端只展示后端算出的 `scheduled_at`。
 *
 * ⚠️ 全部按**本地时间**计算。
 *   `scheduled_at` 落库是 ISO（UTC）字符串，但用户说「每天 08:20」指的是本地 08:20。
 *   因此这里用本地时间构造候选时刻（`new Date(y, m, d, h, min)`），
 *   由 `toISOString()` 负责转成 UTC 存储 —— 不要反过来先转 UTC 再加偏移。
 *
 * ⚠️ 本模块**纯函数、不碰数据库**，便于单独用例验证（见 scripts/verify-repeat.mjs）。
 */

/** 循环模式：不循环 / 周期（每天·每周·每月）/ 间隔（每 N 分·时·天） */
export type RepeatMode = 'none' | 'periodic' | 'interval';

/** 周期规格：在固定的「时刻」上重复 */
export interface PeriodicSpec {
  freq: 'daily' | 'weekly' | 'monthly';
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** `freq=weekly` 时用：周几（0=周日 … 6=周六），可多选 */
  byDay?: number[];
  /** `freq=monthly` 时用：几号（1-31） */
  byMonthDay?: number;
}

/** 间隔规格：从上次结束起算，每隔 N 个时间单位跑一次 */
export interface IntervalSpec {
  every: number;
  unit: 'minute' | 'hour' | 'day';
}

export type RepeatSpec = PeriodicSpec | IntervalSpec;

/** 循环任务的必要字段（从 DbTask 里挑出来，避免本模块依赖 db 模块） */
export interface RepeatTaskFields {
  repeat_mode: string | null;
  repeat_spec: string | null;
  repeat_until: string | null;
  repeat_limit: number | null;
  repeat_count: number | null;
}

const UNIT_MS: Record<IntervalSpec['unit'], number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 归一化模式字符串（历史/异常值一律视作 none） */
export function normalizeRepeatMode(raw: unknown): RepeatMode {
  return raw === 'periodic' || raw === 'interval' ? raw : 'none';
}

function isIntIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * 校验并归一化循环规格。
 * 返回 `null` 表示**规格无效** —— 调用方应当拒绝保存，而不是兜一个默认值悄悄跑起来。
 */
export function normalizeRepeatSpec(mode: RepeatMode, raw: unknown): RepeatSpec | null {
  if (mode === 'none') return null;

  let obj: any = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  if (mode === 'interval') {
    const every = Number(obj.every);
    // 上限刻意设得很大（1 年）但**不设下限到 0**：every=0 会让候选时刻等于自身 ⇒ 死循环
    if (!Number.isInteger(every) || every < 1 || every > 36_500) return null;
    const unit = obj.unit;
    if (unit !== 'minute' && unit !== 'hour' && unit !== 'day') return null;
    return { every, unit };
  }

  // mode === 'periodic'
  const freq = obj.freq;
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') return null;
  if (!isIntIn(obj.hour, 0, 23) || !isIntIn(obj.minute, 0, 59)) return null;

  if (freq === 'weekly') {
    const days: number[] = Array.isArray(obj.byDay)
      ? obj.byDay.filter((d: unknown): d is number => isIntIn(d, 0, 6))
      : [];
    const clean = Array.from(new Set<number>(days)).sort((a, b) => a - b);
    // 选了"每周"却没选周几 ⇒ 永远没有下一次，属于无效配置
    if (clean.length === 0) return null;
    return { freq, hour: obj.hour, minute: obj.minute, byDay: clean };
  }

  if (freq === 'monthly') {
    if (!isIntIn(obj.byMonthDay, 1, 31)) return null;
    return { freq, hour: obj.hour, minute: obj.minute, byMonthDay: obj.byMonthDay };
  }

  return { freq, hour: obj.hour, minute: obj.minute };
}

/** 从数据库行字段里取出规格（坏数据返回 null，不抛） */
export function specFromTask(task: RepeatTaskFields): RepeatSpec | null {
  return normalizeRepeatSpec(normalizeRepeatMode(task.repeat_mode), task.repeat_spec);
}

/** 是否是一个「有效配置」的循环任务 */
export function isRepeating(task: RepeatTaskFields): boolean {
  if (normalizeRepeatMode(task.repeat_mode) === 'none') return false;
  return specFromTask(task) !== null;
}

/**
 * 计算**严格晚于** `from` 的下一次执行时刻。
 *
 * @param from  基准（通常是「当前时间」或「本轮结束时间」）
 * @param until 循环截止时间（可选，含）；候选时刻晚于它 ⇒ 返回 null（不再排下一轮）
 * @returns 下一次执行时刻；无法计算或已超出截止时间 ⇒ null
 */
export function computeNextRun(
  spec: RepeatSpec,
  from: Date,
  until?: Date | null
): Date | null {
  const candidate = computeCandidate(spec, from);
  if (!candidate) return null;
  // 防御：候选必须严格在未来，否则调度器会立刻再次触发（死循环）
  if (candidate.getTime() <= from.getTime()) return null;
  if (until && candidate.getTime() > until.getTime()) return null;
  return candidate;
}

function computeCandidate(spec: RepeatSpec, from: Date): Date | null {
  if ('every' in spec) {
    const step = spec.every * UNIT_MS[spec.unit];
    if (!Number.isFinite(step) || step <= 0) return null;
    return new Date(from.getTime() + step);
  }

  const { hour, minute } = spec;

  if (spec.freq === 'daily') {
    const c = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, minute, 0, 0);
    // 用 setDate 而不是 ±86400000ms：跨夏令时/时区偏移变化时，前者保持"本地墙钟时刻"
    if (c.getTime() <= from.getTime()) c.setDate(c.getDate() + 1);
    return c;
  }

  if (spec.freq === 'weekly') {
    const days = spec.byDay ?? [];
    // 最多扫 8 天：今天已在候选内，再补满一整周
    for (let offset = 0; offset <= 7; offset++) {
      const c = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate() + offset,
        hour,
        minute,
        0,
        0
      );
      if (c.getTime() <= from.getTime()) continue;
      if (days.includes(c.getDay())) return c;
    }
    return null;
  }

  // monthly
  const dom = spec.byMonthDay ?? 1;
  // 最多扫 24 个月：本月已过 + 之后 23 个月
  for (let mo = 0; mo <= 24; mo++) {
    const c = new Date(from.getFullYear(), from.getMonth() + mo, dom, hour, minute, 0, 0);
    // ⚠️ JS 的 Date 会把「2 月 31 日」溢出成 3 月 2/3 日 ——
    //    必须回读日期校验，否则「每月 31 日」会在 2 月错误地跑到 3 月初。
    if (c.getDate() !== dom) continue;
    if (c.getTime() > from.getTime()) return c;
  }
  return null;
}

/**
 * 本轮结束后的循环决策。
 *
 * 语义（与用户确认过的口径）：
 *   - `repeat_paused` 只影响「是否还会被调度器触发」，**不影响计数与排期**：
 *     暂停期间跑完的这一轮仍然计数、仍然排好下次时间，只是不会真的触发。
 *   - 次数上限：`repeat_limit` 计的是**已执行轮次**；达到即收尾，不再排下一轮。
 *   - 有效期：下一次时刻晚于 `repeat_until` ⇒ 收尾。
 */
export interface RepeatDecision {
  /** 是否彻底结束循环（不再排下一轮） */
  exhausted: boolean;
  /** 结束后收尾的原因，便于界面说明 */
  reason?: 'limit' | 'until' | 'invalid';
  /** 下一次执行时刻（已结束则为 null） */
  nextAt: Date | null;
  /** 本轮跑完后累计的轮次数 */
  runsDone: number;
}

export function decideAfterRun(task: RepeatTaskFields, now: Date): RepeatDecision {
  const runsDone = (task.repeat_count ?? 0) + 1;
  const mode = normalizeRepeatMode(task.repeat_mode);

  if (mode === 'none') {
    // 非循环任务不参与本决策（调用方不该走到这里，返回"结束"是安全兜底）
    return { exhausted: true, nextAt: null, runsDone };
  }

  const spec = specFromTask(task);
  if (!spec) return { exhausted: true, reason: 'invalid', nextAt: null, runsDone };

  // 次数上限优先判定：达到上限就不必再算下次时间了
  const limit = task.repeat_limit;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && runsDone >= limit) {
    return { exhausted: true, reason: 'limit', nextAt: null, runsDone };
  }

  const until = task.repeat_until ? new Date(task.repeat_until) : null;
  const untilValid = until && !Number.isNaN(until.getTime()) ? until : null;

  const nextAt = computeNextRun(spec, now, untilValid);
  if (!nextAt) {
    return { exhausted: true, reason: untilValid ? 'until' : 'invalid', nextAt: null, runsDone };
  }

  return { exhausted: false, nextAt, runsDone };
}

/** 人类可读描述（卡片与抽屉共用口径） */
export function describeRepeat(mode: RepeatMode, spec: RepeatSpec | null): string {
  if (mode === 'none' || !spec) return '不循环';

  if ('every' in spec) {
    const unitCn = spec.unit === 'minute' ? '分钟' : spec.unit === 'hour' ? '小时' : '天';
    return `每 ${spec.every} ${unitCn}`;
  }

  const hhmm = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
  if (spec.freq === 'daily') return `每天 ${hhmm}`;
  if (spec.freq === 'weekly') {
    const days = (spec.byDay ?? []).map(d => WEEKDAY_CN[d] ?? `周${d}`);
    return `每${days.join('、')} ${hhmm}`;
  }
  return `每月 ${spec.byMonthDay} 日 ${hhmm}`;
}

/** 便利：直接从任务行输出描述 */
export function describeTaskRepeat(task: RepeatTaskFields): string {
  return describeRepeat(normalizeRepeatMode(task.repeat_mode), specFromTask(task));
}
