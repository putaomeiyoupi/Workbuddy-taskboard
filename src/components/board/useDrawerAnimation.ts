/**
 * 抽屉「关闭动画」的统一实现
 * ============================================================================
 * 为什么单独抽出来（2026-09-14 用户报的两个现象，其实是同一个根因）：
 *
 *   现象 A：「点开某个任务 → 关掉 → **再点同一个任务**，抽屉弹出来又自动收回去」
 *   现象 B：「（进行中）点开后屏幕模糊化但没有内容」—— 同源：
 *           抽屉带着「滑出」动画渲染，`forwards` 让它停在屏幕外，只剩遮罩的模糊。
 *
 * 两个坑，缺一个都会复现：
 *   ① **组件在 target 为空时只是 `return null`，并没有卸载** ——
 *      内部 state（`closing`）会一直留着。只按「目标 id 变了」来重置状态的话，
 *      "重新打开**同一个**目标"就不会重置，`closing` 仍是 true → 立刻播滑出动画。
 *   ② **关闭是延迟 220ms 才真正 onClose**（等动画放完）。这段时间里若用户又点了卡片：
 *      - 点的是**同一个**目标 → 外部状态没变化、不重渲染，那个待触发的定时器照样会跑 → 抽屉被关掉；
 *      - 点的是**另一个**目标 → 抽屉先显示新目标，随后被旧定时器关掉。
 *      两种都表现为"刚弹出来就自动收回去"。
 *
 * 所以规则是：**每次打开/切换目标都必须「取消未触发的关闭定时器 + 复位 closing」**。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 与 CSS 中 `.task-drawer--out` 的动画时长保持一致 */
const CLOSE_ANIMATION_MS = 220;

export interface DrawerAnimation {
  /** true = 正在播放滑出动画 */
  closing: boolean;
  /** 请求关闭：先播动画，动画结束再真正 onClose */
  requestClose: () => void;
}

/**
 * @param openKey 当前目标的稳定标识；**为空/null 表示抽屉已关闭**。
 *                每次该值变化（含从空变为某值）都会复位关闭状态。
 * @param onClose 动画结束后真正关闭（由父级清空目标）
 */
export function useDrawerAnimation(openKey: string | null, onClose: () => void): DrawerAnimation {
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const cancelPendingClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // 打开或切换目标：取消未触发的关闭定时器 + 复位动画状态
  useEffect(() => {
    if (!openKey) return; // 已关闭：什么都不做，让滑出动画正常收尾
    cancelPendingClose();
    setClosing(false);
  }, [openKey, cancelPendingClose]);

  // 卸载时清掉定时器，避免对着已卸载组件调用 setState / onClose
  useEffect(() => cancelPendingClose, [cancelPendingClose]);

  const requestClose = useCallback(() => {
    cancelPendingClose();
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onCloseRef.current();
    }, CLOSE_ANIMATION_MS);
  }, [cancelPendingClose]);

  return { closing, requestClose };
}
