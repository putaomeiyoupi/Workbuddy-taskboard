/**
 * useSdkStatus —— Agent SDK 可用性探测结果
 *
 * 用途：新建任务对话框据此决定「本地」执行器是否可选。
 *
 * 背景：本机 CLI 在非交互模式下会静默挂起（凭据保护策略），
 * 导致 Agent SDK 无法初始化，`local` 执行器实际不可用。
 * 该状态由后端探测并缓存（见 server/sdkStatus.ts），
 * 若将来凭据问题解决，探测成功即自动恢复，前端无需改动。
 */

import { useCallback, useEffect, useState } from 'react';

const API_BASE = '/api';

export interface SdkStatus {
  /** null = 尚未探测 */
  available: boolean | null;
  checkedAt: number | null;
  reason: string | null;
  cooldownMs: number;
  coolingDown: boolean;
}

export interface UseSdkStatusResult {
  status: SdkStatus | null;
  /** 明确不可用（探测完成且失败） */
  unavailable: boolean;
  loading: boolean;
  /** 强制重新探测（凭据问题解决后可手动恢复） */
  recheck: () => Promise<void>;
}

export function useSdkStatus(): UseSdkStatusResult {
  const [status, setStatus] = useState<SdkStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const recheck = useCallback(async (force = true) => {
    try {
      setLoading(true);
      const r = await fetch(`${API_BASE}/sdk/status${force ? '?force=1' : ''}`);
      if (!r.ok) return;
      setStatus(await r.json());
    } catch {
      // 非关键路径：失败时保持未知，UI 不做禁用
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    recheck(false);
  }, [recheck]);

  return {
    status,
    // 只有「探测完成且明确失败」才禁用，未知状态不禁用（不误伤）
    unavailable: status?.available === false,
    loading,
    recheck: () => recheck(true),
  };
}
