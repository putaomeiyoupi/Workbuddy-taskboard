/**
 * 「下次执行」倒计时节拍
 * ============================================================================
 * 为什么要有这个 hook（用户反馈）：定时任务距触发不足 1 分钟时，
 * 时间必须**逐秒跳动**（「43 秒后」→「42 秒后」…），否则看着像卡住了。
 * 而距触发还有几小时/几天时，每秒重渲染纯属浪费 —— 所以按距离分档。
 *
 * ⚠️ 为什么不能直接 `setInterval(..., 1000)` 一档到底：
 *   看板上可能同时有几十张定时卡，每张每秒重渲染会让整块看板持续抖。
 *
 * ⚠️ 分档切换的坑（本 hook 的核心）：`near` 必须由**节拍自己算**，
 *   不能只依赖 render 时算出来的值 —— 否则「30 秒节拍」在跨过 60 秒门槛后
 *   仍要等满 30 秒才醒过来，读秒会从「还剩 30 秒」直接跳到「还剩 0 秒」。
 *   这里用 ref 记住下一跳该用多快，每次 tick 后重新判定。
 */

import { useEffect, useRef, useState } from 'react';

/** 进入这个窗口内就切到秒级读秒 */
const NEAR_MS = 60_000;
/** 近场节拍 */
const NEAR_TICK_MS = 1000;
/** 远场节拍（"几小时后"不需要每秒动） */
const FAR_TICK_MS = 30_000;

/**
 * 返回一个会随目标时间临近而自动加快的 `now`（毫秒时间戳）。
 *
 * @param targetTs 目标时间戳（毫秒）。为 null/undefined 时不启节拍，返回当前时间。
 */
export function useCountdownClock(targetTs: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  /** 下一跳的间隔；用 ref 让 tick 内部能自我修正档位 */
  const tickRef = useRef(FAR_TICK_MS);

  useEffect(() => {
    if (!targetTs) return undefined;

    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      const left = targetTs - Date.now();
      // 已过期或远场：低频；进入 60 秒内：秒级
      tickRef.current = left > 0 && left <= NEAR_MS ? NEAR_TICK_MS : FAR_TICK_MS;
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule(); // 每跳后重新判档 → 跨过 60 秒门槛当秒即切，不丢读秒
      }, tickRef.current);
    };

    // 立刻对一次表：打开页面/切回前台时先同步，别等第一个 interval
    setNow(Date.now());
    schedule();

    return () => clearTimeout(timer);
  }, [targetTs]);

  return now;
}
