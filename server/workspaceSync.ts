/**
 * 工作空间与宿主对齐（Workspace Reconciliation）
 * ============================================================================
 * 用户反馈（2026-09-14）：
 *   「软件中的工作空间比 WorkBuddy 中多很多，两边应该是保持一致的。
 *     个人认为，除非有特别原因。」
 *
 * 为什么之前会越差越多：
 *   - 宿主 → 看板只有「导入缺失的」单向动作，从不清理；
 *   - 看板自己还能随手新建，且**不校验路径重复** ——
 *     实测本机 30 条里有 26 条指向同一个目录（测试残留）。
 *
 * ⚠️ 路径重复不只是"看着乱"：调度互锁按 `workspace_id` 分组，
 * 同一目录挂两个 id 就有两条互不相干的互锁键 → **同一目录可被并行修改**。
 * 所以 db 层加了 `lower(trim(path))` 唯一索引，本模块负责把存量对齐、并把差异讲清楚。
 *
 * 设计原则：
 *   - **只读宿主**（宿主库仍然绝不写入）
 *   - 差异全部展示给用户，由用户点确认；本模块不做任何隐式删除
 *   - 删除前必须处理引用：要么用户指定把任务改挂到哪个空间，要么拒绝并报数
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as db from './db.js';
import * as hostAdapter from './hostAdapter.js';

export interface BoardWorkspaceView {
  id: string;
  name: string;
  path: string;
  /** 引用该空间的任务数（含已终结任务 —— 删除前要一并考虑） */
  taskCount: number;
  /** 目录当前是否还存在（不存在通常是历史残留） */
  pathExists: boolean;
  createdAt: string;
}

export interface HostWorkspaceView {
  path: string;
  lastOpenedAt: number;
}

export interface DuplicateGroup {
  /** 归一化后的路径键（小写去空白） */
  key: string;
  path: string;
  count: number;
  /** 合并后会保留的那条（最早创建） */
  keepId: string;
  keepName: string;
  /** 会被合并掉的 id */
  dropIds: string[];
  taskCount: number;
}

export interface WorkspaceDiff {
  hostAvailable: boolean;
  hostDir: string;
  hostError?: string;
  /**
   * ⚠️ `boardCount` / `hostCount` 是**原始行数**（含"同路径重复"的多条记录），
   *    因此它们**不能**与按路径归类的数相加对账 —— 用户看到
   *    「看板 5 个 · WorkBuddy 4 个」时会以为这两个数该有关系，歧义就出在这里。
   *    要给用户看的"一共 / 都有 / 各自独有"必须用**按归一化路径**算出的三个集合：
   *    `both.length + onlyBoard.length + onlyHost.length` 才是真正的并集。
   *    （`both` 已随本结构返回，**不要再加一个 bothCount** —— 那是重复真源。）
   */
  boardCount: number;
  hostCount: number;
  /** 同路径重复（必须先合并，否则唯一索引与互锁都不成立） */
  duplicates: DuplicateGroup[];
  /** 仅宿主有 —— 点「导入」即可补齐 */
  onlyHost: HostWorkspaceView[];
  /** 仅看板有 —— 需要用户判断是「特别原因」还是残留 */
  onlyBoard: BoardWorkspaceView[];
  /** 两边都有（正常状态） */
  both: Array<{ id: string; name: string; path: string }>;
  fetchedAt: string;
}

const norm = (p: string): string => p.trim().toLowerCase();

function dirExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 计算看板与宿主的差异。纯读，不做任何修改。 */
export function diffWorkspaces(): WorkspaceDiff {
  const boardRows = db.getAllWorkspaces();
  const hostProbe = hostAdapter.isHostAvailable();
  const hostRows = hostProbe.available ? hostAdapter.getHostWorkspaces() : [];

  const hostByKey = new Map<string, HostWorkspaceView>();
  for (const h of hostRows) {
    hostByKey.set(norm(h.path), { path: h.path, lastOpenedAt: h.last_opened_at });
  }

  // 看板侧按归一化路径分组，一次算出重复与引用数
  const groups = new Map<string, db.DbWorkspace[]>();
  for (const w of boardRows) {
    const k = norm(w.path);
    const list = groups.get(k);
    if (list) list.push(w);
    else groups.set(k, [w]);
  }

  const duplicates: DuplicateGroup[] = [];
  const onlyBoard: BoardWorkspaceView[] = [];
  const both: Array<{ id: string; name: string; path: string }> = [];
  const taskCountCache = new Map<string, number>();
  const taskCountOf = (id: string): number => {
    if (!taskCountCache.has(id)) taskCountCache.set(id, db.countTasksUsingWorkspace(id));
    return taskCountCache.get(id)!;
  };

  for (const [key, rows] of groups) {
    const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (sorted.length > 1) {
      duplicates.push({
        key,
        path: sorted[0].path,
        count: sorted.length,
        keepId: sorted[0].id,
        keepName: sorted[0].name,
        dropIds: sorted.slice(1).map(r => r.id),
        taskCount: sorted.reduce((n, r) => n + taskCountOf(r.id), 0),
      });
    }
    // 归类用「保留项」代表该路径
    const keep = sorted[0];
    if (hostByKey.has(key)) both.push({ id: keep.id, name: keep.name, path: keep.path });
    else {
      onlyBoard.push({
        id: keep.id,
        name: keep.name,
        path: keep.path,
        taskCount: taskCountOf(keep.id),
        pathExists: dirExists(keep.path),
        createdAt: keep.created_at,
      });
    }
  }

  const boardKeys = new Set(groups.keys());
  const onlyHost = [...hostByKey.entries()]
    .filter(([k]) => !boardKeys.has(k))
    .map(([, v]) => v)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

  return {
    hostAvailable: hostProbe.available,
    hostDir: hostProbe.hostDir,
    hostError: hostProbe.error,
    boardCount: boardRows.length,
    hostCount: hostRows.length,
    duplicates,
    onlyHost,
    onlyBoard: onlyBoard.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    both: both.sort((a, b) => a.path.localeCompare(b.path)),
    fetchedAt: new Date().toISOString(),
  };
}

export interface SyncOptions {
  /** 合并同路径重复（无损：任务改指保留项，不丢任务） */
  mergeDuplicates?: boolean;
  /** 把仅宿主有的目录导入看板 */
  importMissing?: boolean;
  /** 要移除的看板空间 id（仅看板有的那些） */
  removeIds?: string[];
  /**
   * 移除时把被引用任务改挂到哪个空间（null = 置空）。
   * 不提供该字段时，**只要还有任务引用就拒绝删除**并报数量 ——
   * 免得用户以为"只是删个空间"，实际连任务一起没了。
   */
  reassignTo?: string | null;
}

export interface SyncReport {
  merged?: { groups: number; removed: number; movedTasks: number };
  imported: number;
  importedSkipped: number;
  removed: string[];
  /** 因仍被任务引用而拒绝删除的 */
  blocked: Array<{ id: string; name: string; path: string; taskCount: number }>;
  reassignedTasks: number;
  notes: string[];
}

/** 应用同步动作。所有动作都由用户在前端逐项确认后传入。 */
export function applyWorkspaceSync(opts: SyncOptions): SyncReport {
  const report: SyncReport = {
    imported: 0,
    importedSkipped: 0,
    removed: [],
    blocked: [],
    reassignedTasks: 0,
    notes: [],
  };

  if (opts.mergeDuplicates) {
    report.merged = db.mergeDuplicateWorkspaces();
    if (report.merged.removed > 0) {
      report.notes.push(
        `合并 ${report.merged.groups} 组同路径工作空间，迁移 ${report.merged.movedTasks} 个任务`
      );
    }
  }

  if (opts.importMissing) {
    const diff = diffWorkspaces();
    if (!diff.hostAvailable) {
      report.notes.push(`宿主不可用，未导入：${diff.hostError ?? '未知原因'}`);
    } else {
      for (const h of diff.onlyHost) {
        const name = path.basename(h.path) || h.path;
        const { deduped } = db.createWorkspace({
          id: randomUUID(),
          name,
          path: h.path,
          max_concurrency: 1,
          description: '从 WorkBuddy 同步',
          color: null,
          created_at: new Date().toISOString(),
        });
        if (deduped) report.importedSkipped += 1;
        else report.imported += 1;
      }
    }
  }

  const removeIds = opts.removeIds ?? [];
  if (removeIds.length > 0) {
    const all = db.getAllWorkspaces();
    // 删完至少要留一个空间，否则调度器下次启动又会造一个"默认工作空间"，白删
    const remainingAfter = all.length - removeIds.length;
    const target = opts.reassignTo ?? null;

    for (const id of removeIds) {
      const ws = all.find(w => w.id === id);
      if (!ws) continue;
      if (target && target === id) {
        report.notes.push(`「${ws.name}」既是待删项又是改挂目标，已跳过`);
        continue;
      }
      const used = db.countTasksUsingWorkspace(id);
      if (used > 0 && target === null) {
        // 未指定改挂目标 → 拒绝，把数量报给用户
        report.blocked.push({ id, name: ws.name, path: ws.path, taskCount: used });
        continue;
      }
      if (remainingAfter <= 0) {
        report.notes.push('不能删光所有工作空间（至少保留一个）');
        break;
      }
      if (used > 0 && target) {
        db.reassignTasksWorkspace(id, target);
        report.reassignedTasks += used;
      }
      if (db.deleteWorkspace(id)) report.removed.push(id);
    }
  }

  return report;
}
