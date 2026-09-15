/**
 * RRULE 人性化格式化
 *
 * 宿主（WorkBuddy）的定时任务用 RFC 5545 RRULE 表达，例如：
 *   FREQ=DAILY;BYHOUR=8;BYMINUTE=20        → 每天 08:20
 *   FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0 → 每周一、三、五 09:00
 *   FREQ=HOURLY;INTERVAL=2                 → 每 2 小时
 *   FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0 → 每月 1、15 日 09:00
 *
 * 看板的「自动化定时」板块需要给人看，直接展示原始 RRULE 可读性差，
 * 这里做一层轻量翻译。解析失败时原样返回，绝不抛异常。
 */

const WEEKDAY_LABEL: Record<string, string> = {
  MO: '一',
  TU: '二',
  WE: '三',
  TH: '四',
  FR: '五',
  SA: '六',
  SU: '日',
};

/** 把 RRULE 或 ISO 时间串格式化成人话 */
export function formatRrule(input: string | null | undefined): string {
  if (!input) return '未设置排期';

  const raw = input.trim();

  // 非 RRULE（可能是 ISO 时间串）→ 直接格式化时间
  if (!raw.toUpperCase().startsWith('FREQ=')) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return raw;
  }

  try {
    const parts = new Map<string, string>();
    for (const seg of raw.split(';')) {
      const [k, v] = seg.split('=');
      if (k && v) parts.set(k.trim().toUpperCase(), v.trim());
    }

    const freq = (parts.get('FREQ') || '').toUpperCase();
    const interval = Number(parts.get('INTERVAL') || '1') || 1;
    const byHour = parts.get('BYHOUR');
    const byMinute = parts.get('BYMINUTE');
    const byDay = parts.get('BYDAY');
    const byMonthDay = parts.get('BYMONTHDAY');

    const time = formatTimePart(byHour, byMinute);

    switch (freq) {
      case 'HOURLY':
        return interval > 1 ? `每 ${interval} 小时` : '每小时';

      case 'DAILY': {
        const base = interval > 1 ? `每 ${interval} 天` : '每天';
        return time ? `${base} ${time}` : base;
      }

      case 'WEEKLY': {
        const dayLabel = byDay
          ? byDay
              .split(',')
              .map(d => WEEKDAY_LABEL[d.trim().toUpperCase()] ?? d.trim())
              .join('、')
          : '';
        const base = interval > 1 ? `每 ${interval} 周` : '每周';
        const withDay = dayLabel ? `${base}${dayLabel}` : base;
        return time ? `${withDay} ${time}` : withDay;
      }

      case 'MONTHLY': {
        const dayLabel = byMonthDay
          ? byMonthDay
              .split(',')
              .map(d => `${d.trim()} 日`)
              .join('、')
          : '';
        const base = interval > 1 ? `每 ${interval} 个月` : '每月';
        const withDay = dayLabel ? `${base}${dayLabel}` : base;
        return time ? `${withDay} ${time}` : withDay;
      }

      case 'YEARLY':
        return time ? `每年 ${time}` : '每年';

      default:
        return raw;
    }
  } catch {
    return raw;
  }
}

function formatTimePart(byHour?: string, byMinute?: string): string {
  if (!byHour) return '';
  const h = byHour.split(',')[0].trim();
  const m = byMinute ? byMinute.split(',')[0].trim() : '0';
  const hh = Number(h);
  const mm = Number(m);
  if (Number.isNaN(hh)) return '';
  return `${pad(hh)}:${pad(Number.isNaN(mm) ? 0 : mm)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 判断一个 RRULE 是否描述「周期任务」（相对于一次性定时） */
export function isRecurring(rrule: string | null | undefined): boolean {
  return !!rrule && rrule.trim().toUpperCase().startsWith('FREQ=');
}
