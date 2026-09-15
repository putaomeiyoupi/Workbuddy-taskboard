/**
 * useWorkspaces —— 工作空间与全局调度设置
 *
 * 工作空间是任务执行的工作目录，同时也是调度的互锁维度：
 * 同一工作空间内同时运行的任务数受 max_concurrency 限制。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace, AppSettings, SchedulerStatus } from '../types';

const API_BASE = '/api';

export interface UseWorkspacesResult {
  workspaces: Workspace[];
  settings: AppSettings;
  schedulerStatus: SchedulerStatus | null;
  loading: boolean;
  error: string | null;

  createWorkspace: (payload: {
    name: string;
    path: string;
    max_concurrency?: number;
    description?: string;
    color?: string;
  }) => Promise<Workspace | null>;

  updateWorkspace: (
    id: string,
    patch: Partial<Pick<Workspace, 'name' | 'path' | 'max_concurrency' | 'description' | 'color'>>
  ) => Promise<Workspace | null>;

  deleteWorkspace: (id: string) => Promise<boolean>;

  updateGlobalConcurrency: (n: number) => Promise<void>;

  /**
   * 从 WorkBuddy 宿主同步工作空间：
   * 宿主有而看板没有的目录，一键补进看板（path 相同时跳过）。
   * 返回新增数量。**只读宿主，只写看板自有库。**
   */
  importFromHost: () => Promise<{ added: number; skipped: number }>;

  /** 看板 ↔ WorkBuddy 工作空间差异（只读） */
  fetchWorkspaceDiff: () => Promise<WorkspaceDiff | null>;
  /** 应用同步（逐项显式：合并重复 / 导入缺失 / 移除指定） */
  applyWorkspaceSync: (opts: WorkspaceSyncOptions) => Promise<WorkspaceSyncReport | null>;

  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

/** 差异里的重复分组（同路径多条） */
export interface WorkspaceDuplicateGroup {
  key: string;
  path: string;
  count: number;
  keepId: string;
  keepName: string;
  dropIds: string[];
  taskCount: number;
}

export interface WorkspaceDiff {
  hostAvailable: boolean;
  hostDir: string;
  hostError?: string;
  boardCount: number;
  hostCount: number;
  duplicates: WorkspaceDuplicateGroup[];
  onlyHost: Array<{ path: string; lastOpenedAt: number }>;
  onlyBoard: Array<{
    id: string;
    name: string;
    path: string;
    taskCount: number;
    pathExists: boolean;
    createdAt: string;
  }>;
  both: Array<{ id: string; name: string; path: string }>;
  fetchedAt: string;
}

export interface WorkspaceSyncOptions {
  mergeDuplicates?: boolean;
  importMissing?: boolean;
  removeIds?: string[];
  /** 移除时把被引用的任务改挂到哪个空间；不传则「有任务引用就拒绝删除」 */
  reassignTo?: string | null;
}

export interface WorkspaceSyncReport {
  merged?: { groups: number; removed: number; movedTasks: number };
  imported: number;
  importedSkipped: number;
  removed: string[];
  blocked: Array<{ id: string; name: string; path: string; taskCount: number }>;
  reassignedTasks: number;
  notes: string[];
}

export function useWorkspaces(): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ global_concurrency: 3 });
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        // ignore
      }
      throw new Error(message);
    }
    return res.json();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [ws, st] = await Promise.all([
        request(`${API_BASE}/workspaces`),
        request(`${API_BASE}/settings`),
      ]);
      setWorkspaces(ws as Workspace[]);
      setSettings(st as AppSettings);
      setError(null);
    } catch (err: any) {
      setError(err?.message || '加载工作空间失败');
    } finally {
      setLoading(false);
    }
  }, [request]);

  /**
   * 拉取调度器状态（看板顶部的槽位占用展示）。
   *
   * 🔴 必须**内容判重后再 setState**。
   *    `/api/scheduler/status` 在无事发生时每次返回**内容逐字相同**的对象，
   *    但 `fetch().json()` 每次都产生新引用 ⇒ 无条件 setState 会让整棵消费它的子树
   *    每 5 秒白重渲染一次（实测该状态本身稳定，两次采样逐字相同）。
   *
   *    与 `host_snapshot` 是同一类问题，也是同一个教训：
   *    **「内容没变却更新状态」= 白重渲染**，而高频白重渲染能把渲染进程拖崩
   *    （2026-09-15 实测：Microsoft Edge 153 在"每 3 秒一次全树重渲染"下约 35 秒
   *     报 STATUS_ACCESS_VIOLATION）。
   */
  const statusSigRef = useRef('');
  const refreshStatus = useCallback(async () => {
    try {
      const st = (await request(`${API_BASE}/scheduler/status`)) as SchedulerStatus;
      const sig = JSON.stringify(st);
      if (sig === statusSigRef.current) return; // 无变化 ⇒ 保持原引用，不触发渲染
      statusSigRef.current = sig;
      setSchedulerStatus(st);
    } catch {
      // 静默失败，状态面板不是关键路径
    }
  }, [request]);

  /** 拉取与 WorkBuddy 的工作空间差异（只读，不改任何东西） */
  const fetchWorkspaceDiff = useCallback(async (): Promise<WorkspaceDiff | null> => {
    try {
      return (await request(`${API_BASE}/workspaces/reconcile`)) as WorkspaceDiff;
    } catch (err: any) {
      setError(err?.message || '读取工作空间差异失败');
      return null;
    }
  }, [request]);

  /** 应用同步动作；成功后刷新本地列表与调度状态 */
  const applyWorkspaceSync = useCallback(
    async (opts: WorkspaceSyncOptions): Promise<WorkspaceSyncReport | null> => {
      try {
        const data = (await request(`${API_BASE}/workspaces/sync`, {
          method: 'POST',
          body: JSON.stringify(opts),
        })) as { report: WorkspaceSyncReport };
        await refresh();
        await refreshStatus();
        return data.report;
      } catch (err: any) {
        setError(err?.message || '同步失败');
        return null;
      }
    },
    [request, refresh, refreshStatus]
  );

  useEffect(() => {
    refresh();
    refreshStatus();
  }, [refresh, refreshStatus]);

  // 调度状态轮询（5s）：用于展示全局槽位占用
  useEffect(() => {
    const timer = setInterval(() => {
      refreshStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const createWorkspace = useCallback(
    async (payload: {
      name: string;
      path: string;
      max_concurrency?: number;
      description?: string;
      color?: string;
    }): Promise<Workspace | null> => {
      try {
        const ws = (await request(`${API_BASE}/workspaces`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })) as Workspace;
        setWorkspaces(prev => [...prev, ws]);
        return ws;
      } catch (err: any) {
        setError(err?.message || '创建工作空间失败');
        return null;
      }
    },
    [request]
  );

  const updateWorkspace = useCallback(
    async (
      id: string,
      patch: Partial<Pick<Workspace, 'name' | 'path' | 'max_concurrency' | 'description' | 'color'>>
    ): Promise<Workspace | null> => {
      try {
        const ws = (await request(`${API_BASE}/workspaces/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })) as Workspace;
        setWorkspaces(prev => prev.map(w => (w.id === id ? ws : w)));
        return ws;
      } catch (err: any) {
        setError(err?.message || '更新工作空间失败');
        return null;
      }
    },
    [request]
  );

  const deleteWorkspace = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await request(`${API_BASE}/workspaces/${id}`, { method: 'DELETE' });
        setWorkspaces(prev => prev.filter(w => w.id !== id));
        return true;
      } catch (err: any) {
        setError(err?.message || '删除工作空间失败');
        return false;
      }
    },
    [request]
  );

  const updateGlobalConcurrency = useCallback(
    async (n: number) => {
      try {
        const st = (await request(`${API_BASE}/settings`, {
          method: 'PATCH',
          body: JSON.stringify({ global_concurrency: n }),
        })) as AppSettings;
        setSettings(st);
      } catch (err: any) {
        setError(err?.message || '更新全局并发失败');
      }
    },
    [request]
  );

  /**
   * 从宿主导入工作空间。
   * 取宿主 workspaces 的 path 列表，与看板现有 path 比对后补充缺失项。
   * 宿主侧只读；写入仅发生在看板自有库。
   */
  const importFromHost = useCallback(async () => {
    const snap = (await request(`${API_BASE}/host/snapshot`)) as {
      available: boolean;
      workspaces?: Array<{ path: string }>;
      error?: string;
    };

    if (!snap?.available) {
      throw new Error(snap?.error || 'WorkBuddy 宿主数据不可用');
    }

    const hostPaths = (snap.workspaces ?? []).map(w => w.path).filter(Boolean);
    const existing = new Set(workspaces.map(w => w.path.toLowerCase()));

    let added = 0;
    let skipped = 0;
    for (const p of hostPaths) {
      if (existing.has(p.toLowerCase())) {
        skipped++;
        continue;
      }
      // 用目录末段作为默认名称，便于识别
      const parts = p.split(/[\\/]/).filter(Boolean);
      const name = parts[parts.length - 1] || p;
      const created = await createWorkspace({
        name,
        path: p,
        max_concurrency: 1,
        description: '从 WorkBuddy 导入',
      });
      if (created) {
        existing.add(p.toLowerCase());
        added++;
      }
    }

    await refresh();
    return { added, skipped };
  }, [request, workspaces, createWorkspace, refresh]);

  return {
    workspaces,
    settings,
    schedulerStatus,
    loading,
    error,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    updateGlobalConcurrency,
    importFromHost,
    fetchWorkspaceDiff,
    applyWorkspaceSync,
    refresh,
    refreshStatus,
  };
}
