/**
 * HostDiagHUD —— 宿主嵌入环境下的性能诊断浮层（**仅在 iframe 内渲染**）
 * ============================================================================
 * 背景（2026-09-16）：用户反馈「在 WorkBuddy 的『更多』里打开看板，动画与操作明显卡顿，
 * 浏览器里没有这个问题」，并补充「有界面变化的时候就卡，比如弹出抽屉的时候」。
 *
 * 为了定位，已在普通浏览器（msedge 153）里做了 8 组量化实验，全部**无法复现**：
 *   · 强制软件合成（--disable-gpu）仍 60fps、禁 backdrop-filter 无变化
 *   · 真正关掉 site isolation 让 iframe 同进程 + 父页面忙等占主线程，仍 60fps
 *   · 打开抽屉：只掉 2 帧（max 33.4ms），禁用全屏 backdrop-filter 后**逐项相同**
 *   · LoAF 只抓到一帧 63ms 的 React 调度（MessagePort.onmessage, blocking 12ms）
 * ⇒ 结论：瓶颈在**宿主自身的渲染环境**（Chromium 版本 / 合成路径 / 宿主 UI 抢占），
 *   而不是看板的某段 CSS。**必须从宿主内部取数**。
 *
 * 本组件就是那个取数口：看板被 iframe 嵌入时自动出现，把宿主的关键指标直接显示出来，
 * 用户读一眼（或截图）即可，无需开发者工具、无需改任何配置。
 *
 * 采集项与用途：
 *   1. **Chromium / Electron 版本** ← 最关键。若宿主 Electron 用的是较旧的 Chromium，
 *      看板里 `color-mix()` / `backdrop-filter` / `mask-image` 等可能走**慢路径**，
 *      而 msedge 153 上早已优化 ⇒ 正好解释"浏览器里不卡、宿主里卡"。
 *   2. 实时 fps / p50 / p95 / 掉帧数 ← 确认卡到什么程度。
 *   3. LoAF 长帧（>50ms）及其触发者 ← 指出是**谁**把某帧撑爆的。
 *   4. DPR / 视口尺寸。
 *
 * 使用（**默认不显示**，按需开启）：
 *   · 浏览器：打开 `http://127.0.0.1:47831/?diag=1`
 *   · 宿主面板：把 `~/.workbuddy/extensions/task-kanban/extension.json` 里
 *     `ui.entry.url` 临时改成 `.../index.html?diag=1`，刷新面板即可
 *   · 或在控制台执行 `kanbanHostDiag.show()`（`hide()` / `status()` 同理）
 *   · 关闭浮层：点右上角「×」（本次会话内不再出现）
 *
 * ⚠️ 2026-09-16 用户要求：**取消默认显示，但保留代码供以后调试** ⇒ 默认关闭。
 */

import React, { useEffect, useRef, useState } from 'react';
import { storageGet, storageSet } from '../utils/safeStorage';

/** 统计刷新间隔 */
const TICK_MS = 1000;
/** 环形缓冲上限（约 10 秒 @60fps） */
const BUF_MAX = 600;

interface LoafRec {
  dur: number;
  blocking: number;
  inv: string;
}

interface FrameStat {
  fps: number;
  p50: number;
  p95: number;
  max: number;
  over33: number;
  n: number;
}

function parseBrowser(ua: string): string {
  const c = /Chrome\/(\d+)/.exec(ua) || /Chromium\/(\d+)/.exec(ua);
  const e = /Electron\/([\d.]+)/.exec(ua);
  const parts: string[] = [];
  parts.push(c ? `Chromium ${c[1]}` : 'Chromium ?');
  if (e) parts.push(`Electron ${e[1]}`);
  return parts.join(' · ');
}

/** 是否被 iframe 嵌入（宿主面板的形态）。跨源时 window.top 比较本身是安全的。 */
function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // 取不到说明确实跨了源（= 被嵌入）
  }
}

/** 开启诊断模式的存储开关（local / session 任一为 '1' 即生效） */
const DIAG_KEY = 'kanban.hostDiag';
/** 用户点「×」后记在本会话，不再打扰 */
const CLOSED_KEY = 'kanban.hostDiagClosed';

/**
 * 是否请求了诊断模式。**默认否** —— HUD 只在显式开启时出现：
 *   · URL 带 `?diag=1` 或 `#diag`
 *   · 或 storage 里 `kanban.hostDiag` = '1'
 * 走 safeStorage：存储受限环境下这里同样不允许抛错（否则诊断工具自己先把页面弄崩了）。
 */
function diagRequested(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('diag') === '1') return true;
    if (window.location.hash === '#diag') return true;
  } catch {
    /* URL 解析失败不影响 */
  }
  return storageGet(DIAG_KEY, 'local') === '1' || storageGet(DIAG_KEY, 'session') === '1';
}

export const HostDiagHUD: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [stat, setStat] = useState<FrameStat | null>(null);
  const [loafs, setLoafs] = useState<LoafRec[]>([]);
  const bufRef = useRef<number[]>([]);

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

  /**
   * **默认关闭**：只有显式请求诊断（`?diag=1` / storage 开关）且用户没关过时才出现。
   * ⚠️ 不限制"必须在 iframe 内" —— 浏览器里加 `?diag=1` 同样可用，调试更方便。
   */
  useEffect(() => {
    if (!diagRequested()) return;
    if (storageGet(CLOSED_KEY, 'session') === '1') return;
    setVisible(true);
  }, []);

  /** 控制台/调试入口：kanbanHostDiag.show() / hide() / status() */
  useEffect(() => {
    const api = {
      show: () => setVisible(true),
      hide: () => setVisible(false),
      status: () => ({ visible, embedded: isEmbedded(), requested: diagRequested() }),
    };
    (window as unknown as { kanbanHostDiag?: typeof api }).kanbanHostDiag = api;
    return () => {
      delete (window as unknown as { kanbanHostDiag?: typeof api }).kanbanHostDiag;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      const d = t - last;
      last = t;
      // 首帧常常异常大（页面刚挂载），丢掉
      if (d > 0 && d < 5000) {
        bufRef.current.push(d);
        if (bufRef.current.length > BUF_MAX) bufRef.current.shift();
      }
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const timer = window.setInterval(() => {
      const a = bufRef.current;
      if (!a.length) return;
      const sorted = [...a].sort((x, y) => x - y);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      setStat({
        fps: +(1000 / (a.reduce((x, y) => x + y, 0) / a.length)).toFixed(1),
        p50: +q(0.5).toFixed(1),
        p95: +q(0.95).toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1),
        over33: a.filter(x => x > 33).length,
        n: a.length,
      });
      bufRef.current = [];
    }, TICK_MS);

    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver(list => {
        const recs: LoafRec[] = list.getEntries().map((e: PerformanceEntry) => {
          const anyE = e as unknown as {
            blockingDuration?: number;
            scripts?: Array<{ invoker?: string; sourceFunctionName?: string }>;
          };
          const s = (anyE.scripts ?? [])[0];
          return {
            dur: Math.round(e.duration),
            blocking: Math.round(anyE.blockingDuration ?? 0),
            inv: (s?.sourceFunctionName || s?.invoker || '').slice(0, 42),
          };
        });
        if (recs.length) setLoafs(prev => [...recs, ...prev].slice(0, 4));
      });
      po.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit);
    } catch {
      /* 宿主 Chromium 太旧则不支持 LoAF —— 这本身也是有用的信号 */
    }

    return () => {
      stop = true;
      window.clearInterval(timer);
      po?.disconnect();
    };
  }, [visible]);

  if (!visible) return null;

  const fpsColor = !stat ? '#94a3b8' : stat.fps >= 55 ? '#34d399' : stat.fps >= 40 ? '#fbbf24' : '#f87171';

  const close = () => {
    storageSet(CLOSED_KEY, '1', 'session');
    setVisible(false);
  };

  return (
    <div
      style={{
        position: 'fixed',
        right: 10,
        bottom: 10,
        zIndex: 99999,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        color: '#cbd5e1',
        background: 'rgba(5,8,15,0.94)',
        border: '1px solid rgba(148,163,184,0.45)',
        borderRadius: 8,
        padding: '8px 10px',
        maxWidth: 360,
        boxShadow: '0 8px 28px -8px rgba(0,0,0,0.9)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <b style={{ color: '#7dd3fc' }}>宿主诊断</b>
        <span style={{ color: '#475569' }}>(?diag=1 开启)</span>
        <button
          onClick={close}
          style={{
            marginLeft: 'auto', background: 'transparent', border: 0,
            color: '#64748b', cursor: 'pointer', fontSize: 14, lineHeight: 1,
          }}
          aria-label="关闭诊断"
        >
          ×
        </button>
      </div>

      <div>
        <span style={{ color: '#64748b' }}>浏览器 </span>
        {parseBrowser(ua)}
      </div>
      <div>
        <span style={{ color: '#64748b' }}>DPR </span>
        {dpr}
        <span style={{ color: '#64748b' }}> · 视口 </span>
        {window.innerWidth}×{window.innerHeight}
      </div>

      {stat && (
        <>
          <div style={{ fontSize: 17, color: fpsColor, fontWeight: 600 }}>
            {stat.fps} fps
          </div>
          <div>
            p50 {stat.p50}ms · p95 {stat.p95}ms · max {stat.max}ms
          </div>
          <div>
            <span style={{ color: '#64748b' }}>掉帧(&gt;33ms) </span>
            {stat.over33}/{stat.n}
          </div>
        </>
      )}

      {loafs.length > 0 && (
        <div style={{ marginTop: 4, color: '#fbbf24' }}>
          长帧 {loafs.map(l => `${l.dur}ms`).join(' · ')}
          {loafs[0].inv && (
            <div style={{ color: '#94a3b8' }}>{loafs[0].inv}</div>
          )}
        </div>
      )}
    </div>
  );
};

export default HostDiagHUD;
