/**
 * Agent SDK 可用性探测
 * ============================================================
 * ⚠️ 2026-09-15：本文件头原先写着
 *   「CLI 非交互模式下会静默挂起，握手必然超时，**只有 `--serve` 模式可用**」——
 *   **该描述已被实测推翻，勿再引用。**
 *
 *   真实原因是**鉴权配置缺失**，不是"非交互模式不可用"：
 *   本机凭据在国内站（www.workbuddy.cn），而进程若既没有 `CODEBUDDY_API_KEY`、
 *   又没有 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`，CLI 会连到错误的服务端点并报
 *   `Authentication required. Please use /login command to sign in`。
 *   官方文档明确点名 `CODEBUDDY_INTERNET_ENVIRONMENT` 是**最常被遗漏**的一项。
 *
 *   ✅ 修复后（`server/loadEnv.ts` 加载项目根 `.env` + `.env.example` 模板）实测：
 *   `local` 执行器能正常跑完任务，且宿主 `sessions` 与 `~/.workbuddy/projects/` **零新增**。
 *
 * 影响面：`local` 执行器、`/api/models`（走 SDK 取模型）。
 *
 * 这里把「可用性」做成**带冷却的探测状态**，好处：
 *  - 不要在每次请求 /api/models 时白等一个超时周期并打印堆栈
 *  - 调度器可以据此让 local 任务**立即失败并给出可行动提示**，而不是干等
 *  - 前端可以据此动态禁用「本地」执行器（而不是硬编码）
 *
 * ⚠️ 注意本探测的局限：它调用的是 `unstable_v2_createSession().getAvailableModels()`，
 * **能列模型 ≠ 能执行任务**（实测出现过探测 available=true 但任务因鉴权失败的情况）。
 * 因此不要把它的结果当作"可执行"的唯一依据。
 */

import { unstable_v2_createSession } from '@tencent-ai/agent-sdk';
import { NODE_EXE } from './runtime.js';

/** 单次探测的超时（SDK 默认 60s，太久） */
const PROBE_TIMEOUT_MS = 8_000;

/** 探测失败后的冷却期：期间不再尝试，直接回落 */
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

interface SdkProbeState {
  /** null = 尚未探测 */
  available: boolean | null;
  /** 最近一次探测时间 */
  checkedAt: number | null;
  /** 不可用原因（原文） */
  reason: string | null;
  /** 探测到的模型列表 */
  models: unknown[] | null;
}

const state: SdkProbeState = {
  available: null,
  checkedAt: null,
  reason: null,
  models: null,
};

/**
 * 进行中的探测 Promise —— 单飞用。
 * 避免并发调用各自探测一遍（见 probeSdkModels 的说明）。
 */
let inFlight: Promise<SdkStatusSnapshot> | null = null;

/**
 * 本进程内是否已经报告过「不可用」。
 * 同一种状态只提示一次，避免每次探测都刷屏；完整状态走 GET /api/sdk/status。
 */
let reportedUnavailable = false;

/** 对外暴露的状态快照类型 */
export type SdkStatusSnapshot = SdkProbeState & { cooldownMs: number; coolingDown: boolean };

/** 只读快照 */
export function getSdkStatus(): SdkStatusSnapshot {
  return { ...state, cooldownMs: FAILURE_COOLDOWN_MS, coolingDown: inCooldown(Date.now()) };
}

/**
 * 是否「已知不可用」。
 * 调度器用它决定：local 任务要不要直接快速失败。
 */
export function isSdkKnownUnavailable(): boolean {
  return state.available === false;
}

/** 是否处于失败冷却期（期间跳过探测） */
function inCooldown(now: number): boolean {
  return (
    state.available === false &&
    state.checkedAt !== null &&
    now - state.checkedAt < FAILURE_COOLDOWN_MS
  );
}

/** 把 SDK 的原始报错压成一句人话 */
function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unknown option/i.test(msg)) {
    // 典型：SDK 传了 CLI 不认识的参数（如 --request-timeout-ms），CLI 立即退出
    return `CLI 拒绝了启动参数（${msg.trim()}）—— 多为 SDK 选项与 CLI 版本不匹配，属代码问题`;
  }
  if (/timeout/i.test(msg)) {
    return '初始化握手超时（CLI 无响应）';
  }
  if (/ENOENT/i.test(msg)) {
    return 'CLI 子进程启动失败（spawn ENOENT）：node 运行时未能解析';
  }
  if (/stdout closed|exited|closed unexpectedly/i.test(msg)) {
    return 'CLI 子进程启动后立即退出（常见原因：启动参数不被识别，或监听端口被占用）';
  }
  return msg;
}

/**
 * 探测 SDK 是否可用（通过尝试取模型列表判断）。
 *
 * @param force 忽略冷却、强制重新探测
 */
export async function probeSdkModels(force = false): Promise<SdkStatusSnapshot> {
  // 已成功过：直接复用，不必再连
  if (!force && state.available === true && state.models?.length) {
    return getSdkStatus();
  }
  // 冷却期内直接返回缓存状态
  if (!force && inCooldown(Date.now())) {
    return getSdkStatus();
  }

  /**
   * ⭐ 单飞（single-flight）防并发。
   *
   * 冷却判断发生在 await **之前**，而 checkedAt 要等探测**结束**才写入 ——
   * 两个几乎同时到达的请求（前端启动时会同时打 /api/models 和 /api/sdk/status）
   * 都会看到「不在冷却中」，于是**各探测一次**，日志里同一句提示打印两遍。
   *
   * 这里把进行中的 Promise 暴露出去，并发调用复用同一个结果。
   */
  if (inFlight) return inFlight;

  inFlight = runProbe().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 实际执行一次探测（只应由 probeSdkModels 调用，以享受单飞保护） */
async function runProbe(): Promise<SdkStatusSnapshot> {
  /**
   * ⚠️ 会话必须显式关闭。
   *
   * 本机 CLI 在非交互模式下会**挂起**，探测几乎必然超时 —— 而超时只是"我们不等了"，
   * SDK 那条 `codebuddy-headless` 子进程会**一直挂着**（实测残留了 8 分钟以上，
   * 用户在看进程列表时就发现了"有 3 个在运行"）。所以 finally 里一定要 close()。
   */
  let session: { close?: () => void; getAvailableModels: () => Promise<unknown> } | null = null;
  try {
    session = await unstable_v2_createSession({
      cwd: process.cwd(),
      // 显式指定 node 运行时（本机系统 PATH 无 node）
      executable: NODE_EXE,
      // ⚠️ 不要传 requestTimeoutMs！SDK 会翻译成 `--request-timeout-ms`，
      // 而 CLI 2.137.1 不认识该参数 → `error: unknown option` → 进程立即退出。
      // 超时改用 JS 层的 withTimeout 兜住（见下）。
    });
    const models = await withTimeout(session.getAvailableModels(), PROBE_TIMEOUT_MS);

    if (Array.isArray(models) && models.length > 0) {
      state.available = true;
      state.models = models;
      state.reason = null;
      if (reportedUnavailable) {
        console.log(`[SDK] 已恢复可用，取到 ${models.length} 个模型，模型列表改由 SDK 提供`);
        reportedUnavailable = false;
      }
    } else {
      state.available = false;
      state.models = null;
      state.reason = 'SDK 返回了空模型列表';
      reportUnavailableOnce();
    }
  } catch (err) {
    state.available = false;
    state.models = null;
    state.reason = shortReason(err);
    reportUnavailableOnce();
  } finally {
    // 无论成功失败都要收掉会话（超时路径尤其重要，见上方注释）
    try {
      session?.close?.();
    } catch (err) {
      console.warn(`[SDK] 关闭探测会话失败：${(err as Error)?.message ?? err}`);
    }
  }

  state.checkedAt = Date.now();
  return getSdkStatus();
}

/** JS 层超时包装：SDK 的 requestTimeoutMs 会传非法 CLI 参数，只能自己兜 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`SDK 探测超时（${ms}ms）`)), ms).unref?.()
    ),
  ]);
}

/**
 * 报告「不可用」——**每个状态变化只提示一次**。
 *
 * 这是本机的已知环境限制，不是需要每次探测都刷屏的异常；
 * 完整状态随时可通过 `GET /api/sdk/status` 查询。
 */
function reportUnavailableOnce(): void {
  if (reportedUnavailable) return;
  reportedUnavailable = true;
  console.warn(
    `[SDK] 本地 SDK 不可用：${state.reason}。` +
    '模型列表回落宿主观测值，local 执行器相关任务会快速失败并提示改用 workbuddy。' +
    '状态查询 / 强制重试：GET /api/sdk/status'
  );
}
