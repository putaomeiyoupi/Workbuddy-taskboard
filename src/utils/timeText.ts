/**
 * 时间文案：把时间戳渲染成人能一眼读懂的中文（含倒计时读秒）
 * ============================================================================
 * 抽出共享的原因：卡片底部与抽屉里的「下次执行」必须口径一致 ——
 * 否则同一张任务在两处显示不同的话（"3 分钟后" vs "09-15 02:10"），
 * 用户会以为数据不一致。口径见 `untilTime`（未来）与 `agoTime`（过去）。
 *
 * ⚠️ 关键约定（用户反馈）：距目标 **不足 60 秒必须读秒**。
 *   旧实现用 `Math.floor(diff/60000)` ⇒ 显示「0 分钟后」，看着像坏了。
 */

/** 未来时间 → 「3 秒后 / 5 分钟后 / 2 小时后 / 3 天后」 */
export function untilTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '未排期';
  const diff = ts - now;
  if (diff <= 0) return '待触发';
  if (diff < 60_000) return `${Math.max(1, Math.ceil(diff / 1000))} 秒后`;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟后`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时后`;
  return `${Math.floor(hour / 24)} 天后`;
}

/** 过去时间 → 「刚刚 / 3 分钟前 / 2 小时前 / 3 天前」 */
export function agoTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '—';
  const diff = now - ts;
  if (diff < 0) return untilTime(ts, now);
  if (diff < 60_000) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/**
 * 「下次执行」的**精确倒计时**：`42 秒` / `5 分 12 秒` / `2 小时 5 分`。
 *
 * 与 `untilTime` 的分工：`untilTime` 是卡片底部那种短语（"5 分钟后"），
 * 本函数是抽屉里逐项明细用的精确值（"还有 5 分 12 秒"）—— 明细要更精确，
 * 且不足 1 分钟时**必须逐秒变化**。
 */
export function countdownText(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '未排期';
  const diff = ts - now;
  if (diff <= 0) return '待触发';

  const totalSec = Math.ceil(diff / 1000);
  if (totalSec < 60) return `${totalSec} 秒`;

  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin} 分 ${sec} 秒` : `${totalMin} 分`;

  const hour = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hour < 24) return min > 0 ? `${hour} 小时 ${min} 分` : `${hour} 小时`;

  const day = Math.floor(hour / 24);
  const restHour = hour % 24;
  return restHour > 0 ? `${day} 天 ${restHour} 小时` : `${day} 天`;
}

/**
 * 时间取值口径转换：**看板任务**的 `scheduled_at` 是 ISO 字符串，
 * 而**宿主自动化**的 `next_run_at` 是毫秒时间戳。倒计时工具统一吃数字，
 * 所以调用方用它转一道，避免各写各的 `new Date(x).getTime()`（漏一个就显示 NaN）。
 *
 * @returns 毫秒时间戳；空值或非法时间返回 null
 */
export function toTs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const t = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 毫秒 → HH:MM:SS */export function hms(ts?: number): string {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 毫秒 → 本地完整时间 YYYY-MM-DD HH:MM:SS */
export function fullTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}
