/**
 * 纯函数用例：时间文案（含倒计时读秒）的边界，不依赖 React
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-countdown-text.mjs
 *
 * ⚠️ 重点：**不足 60 秒必须读秒**（用户反馈「显示 0 分钟后，看着像坏了」）。
 *    所以这里对 59s / 1s / 0.2s 都做了断言。
 */
import { untilTime, countdownText, agoTime, toTs } from '../src/utils/timeText.ts';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      实际: ${JSON.stringify(got)}\n      期望: ${JSON.stringify(want)}`);
  }
};

const T0 = 1_800_000_000_000; // 固定基准，避免真实时间抖动

console.log('untilTime（未来 → 短语）：');
eq('未排期', untilTime(null, T0), '未排期');
eq('已过 → 待触发', untilTime(T0 - 1, T0), '待触发');
eq('59.4s → 读秒（60 秒内必须读秒）', untilTime(T0 + 59_400, T0), '60 秒后');
eq('5s', untilTime(T0 + 5_000, T0), '5 秒后');
eq('1s', untilTime(T0 + 1, T0), '1 秒后');
eq('0.2s 向上取整为 1 秒（不能显示 0 秒）', untilTime(T0 + 200, T0), '1 秒后');
eq('60s → 1 分钟', untilTime(T0 + 60_000, T0), '1 分钟后');
eq('59 分钟', untilTime(T0 + 59 * 60_000, T0), '59 分钟后');
eq('60 分钟 → 1 小时', untilTime(T0 + 60 * 60_000, T0), '1 小时后');
eq('23 小时', untilTime(T0 + 23 * 3600_000, T0), '23 小时后');
eq('24 小时 → 1 天', untilTime(T0 + 24 * 3600_000, T0), '1 天后');

console.log('\ncountdownText（抽屉/详情明细 → 精确值，60 秒内逐秒变）：');
eq('未排期', countdownText(null, T0), '未排期');
eq('已过 → 待触发', countdownText(T0 - 5, T0), '待触发');
eq('1s', countdownText(T0 + 1_000, T0), '1 秒');
eq('59s（不进位到分钟）', countdownText(T0 + 59_000, T0), '59 秒');
eq('60s → 1 分', countdownText(T0 + 60_000, T0), '1 分');
eq('72s → 1 分 12 秒', countdownText(T0 + 72_000, T0), '1 分 12 秒');
eq('59分 → 59 分', countdownText(T0 + 59 * 60_000, T0), '59 分');
eq('1h → 1 小时', countdownText(T0 + 3600_000, T0), '1 小时');
eq('1h30m → 1 小时 30 分', countdownText(T0 + 3600_000 + 1800_000, T0), '1 小时 30 分');
eq('23h → 23 小时', countdownText(T0 + 23 * 3600_000, T0), '23 小时');
eq('24h → 1 天', countdownText(T0 + 24 * 3600_000, T0), '1 天');
eq('26h → 1 天 2 小时', countdownText(T0 + 26 * 3600_000, T0), '1 天 2 小时');

console.log('\nagoTime（过去 → 短语）：');
eq('null → —', agoTime(null, T0), '—');
eq('未来时间走 untilTime 分支', agoTime(T0 + 60_000, T0), '1 分钟后');
eq('30s → 刚刚', agoTime(T0 - 30_000, T0), '刚刚');
eq('5 分钟前', agoTime(T0 - 5 * 60_000, T0), '5 分钟前');
eq('59 分钟前', agoTime(T0 - 59 * 60_000, T0), '59 分钟前');
eq('1 小时前', agoTime(T0 - 3600_000, T0), '1 小时前');
eq('23 小时前', agoTime(T0 - 23 * 3600_000, T0), '23 小时前');
eq('1 天前', agoTime(T0 - 24 * 3600_000, T0), '1 天前');

console.log('\ntoTs（ISO 字符串 / 毫秒 → 毫秒；看板任务是 ISO，宿主是毫秒）：');
eq('null → null', toTs(null), null);
eq('undefined → null', toTs(undefined), null);
eq('空串 → null', toTs(''), null);
eq('非法字符串 → null', toTs('not-a-date'), null);
eq('毫秒原样返回', toTs(T0), T0);
eq('ISO 可解析', toTs(new Date(T0).toISOString()), T0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
