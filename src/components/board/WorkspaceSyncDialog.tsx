/**
 * WorkspaceSyncDialog —— 工作空间与 WorkBuddy 对齐
 * ============================================================
 * 用户诉求（2026-09-14）：「看板里的工作空间比 WorkBuddy 多很多，两边应该保持一致，
 * 除非有特别原因。」
 *
 * 本对话框把差异**分类摆出来**，每一项都由用户决定要不要动：
 *   ① 同路径重复  —— 必须处理（同路径两个 id 会破坏调度互锁，db 层已加唯一索引）
 *   ② 仅宿主有    —— 一键导入即可补齐
 *   ③ 仅看板有    —— 需要用户判断是「特别原因」还是历史残留（会显示任务引用数、目录是否还在）
 *
 * ⚠️ 不做任何隐式删除：移除前会校验任务引用；有任务引用时必须显式选择"改挂到哪个空间"。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, Button, MessagePlugin, Select, Loading } from 'tdesign-react';
import {
  RefreshCw,
  AlertTriangle,
  Download,
  Trash2,
  Combine,
  CheckCircle2,
  FolderX,
  FolderOpen,
} from 'lucide-react';
import type { Workspace } from '../../types';
import type {
  WorkspaceDiff,
  WorkspaceSyncOptions,
  WorkspaceSyncReport,
} from '../../hooks/useWorkspaces';

interface WorkspaceSyncDialogProps {
  visible: boolean;
  onClose: () => void;
  /** 看板当前的工作空间（用于选「改挂目标」） */
  workspaces: Workspace[];
  onFetchDiff: () => Promise<WorkspaceDiff | null>;
  onApply: (opts: WorkspaceSyncOptions) => Promise<WorkspaceSyncReport | null>;
}

export const WorkspaceSyncDialog: React.FC<WorkspaceSyncDialogProps> = ({
  visible,
  onClose,
  workspaces,
  onFetchDiff,
  onApply,
}) => {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  /** 勾选要移除的「仅看板有」 */
  const [removeIds, setRemoveIds] = useState<Set<string>>(new Set());
  /** 有任务引用时，把任务改挂到哪个空间（空 = 不删这些） */
  const [reassignTo, setReassignTo] = useState<string>('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await onFetchDiff();
      setDiff(d);
      setRemoveIds(new Set());
    } finally {
      setLoading(false);
    }
  }, [onFetchDiff]);

  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);

  const onlyBoard = diff?.onlyBoard ?? [];
  const duplicates = diff?.duplicates ?? [];
  const onlyHost = diff?.onlyHost ?? [];

  /** 选中的待删项里，有多少被任务引用 */
  const selectedReferenced = useMemo(
    () => onlyBoard.filter(w => removeIds.has(w.id) && w.taskCount > 0),
    [onlyBoard, removeIds]
  );

  const needReassign = selectedReferenced.length > 0;

  const toggle = (id: string) => {
    setRemoveIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (opts: WorkspaceSyncOptions, okText: string) => {
    setApplying(true);
    try {
      const report = await onApply(opts);
      if (!report) {
        MessagePlugin.error('同步失败');
        return;
      }
      const parts: string[] = [];
      if (report.merged && report.merged.removed > 0) {
        parts.push(`合并 ${report.merged.removed} 条重复（迁移 ${report.merged.movedTasks} 个任务）`);
      }
      if (report.imported > 0) parts.push(`导入 ${report.imported} 个`);
      if (report.removed.length > 0) parts.push(`移除 ${report.removed.length} 个`);
      if (report.reassignedTasks > 0) parts.push(`任务改挂 ${report.reassignedTasks} 个`);
      if (report.blocked.length > 0) {
        MessagePlugin.warning(
          `有 ${report.blocked.length} 个空间仍被任务引用，未删除` +
            `（共 ${report.blocked.reduce((n, b) => n + b.taskCount, 0)} 个任务）`
        );
      }
      for (const n of report.notes) MessagePlugin.info(n);
      if (parts.length) MessagePlugin.success(`${okText}：${parts.join(' · ')}`);
      else MessagePlugin.info('没有需要变更的内容');
      await refresh();
    } finally {
      setApplying(false);
    }
  };

  const hasAnything = duplicates.length > 0 || onlyHost.length > 0 || onlyBoard.length > 0;

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      header="与 WorkBuddy 同步工作空间"
      footer={null}
      width={720}
      destroyOnClose
    >
      <div className="space-y-4 text-[14px]">
        {/* 概览 */}
        {/*
          概览口径（用户反馈修正）：
          ⚠️ 原先写「看板 5 个 · WorkBuddy 4 个」，两个数字并列却没有说明关系，
             看起来像是"5 和 4 对不上"；而且它们是**原始行数**（含同路径重复），
             与下面按路径归类的条目也未必一致。
          ✅ 改成按**归一化路径**的三段式，数字之间能自己对账：
             共 = 都有 + 看板独有 + WorkBuddy 独有
             （用户的原话是"一共 5 个工作空间，4 个是 wb 的，1 个是看板的"，
               这里用「两边都有」而不是"wb 的" —— 那 4 个两边都存在，
               说成"WB 的"会让"看板独有"的语义变得含糊。）
             原始行数移进 tooltip，只在排查重复时才有用。
        */}
        <div className="flex items-center gap-3 flex-wrap">
          <span
            style={{ color: '#cbd5e1' }}
            title={
              diff
                ? `看板库共 ${diff.boardCount} 条记录 · WorkBuddy 侧共 ${diff.hostCount} 条` +
                  (diff.duplicates.length
                    ? `\n（含 ${diff.duplicates.length} 组同路径重复，见下方）`
                    : '')
                : undefined
            }
          >
            共{' '}
            <b style={{ color: '#cbd5e1' }}>
              {diff ? diff.both.length + diff.onlyBoard.length + diff.onlyHost.length : '-'}
            </b>{' '}
            个 · 两边都有 <b style={{ color: '#a78bfa' }}>{diff?.both.length ?? '-'}</b> 个
            {diff && diff.onlyBoard.length > 0 && (
              <>
                {' · '}看板独有 <b style={{ color: '#22d3ee' }}>{diff.onlyBoard.length}</b> 个
              </>
            )}
            {diff && diff.onlyHost.length > 0 && (
              <>
                {' · '}WorkBuddy 独有{' '}
                <b style={{ color: '#a78bfa' }}>{diff.onlyHost.length}</b> 个
              </>
            )}
          </span>
          <Button
            size="small"
            variant="text"
            icon={<RefreshCw size={13} />}
            loading={loading}
            onClick={() => void refresh()}
          >
            重新检查
          </Button>
          {diff && !diff.hostAvailable && (
            <span className="text-[13px] flex items-center gap-1" style={{ color: '#fca5a5' }}>
              <AlertTriangle size={12} />
              读不到 WorkBuddy 数据（{diff.hostError ?? '未知原因'}），无法对齐
            </span>
          )}
        </div>

        {loading && !diff ? (
          <div className="flex items-center gap-2 py-6 justify-center" style={{ color: '#64748b' }}>
            <Loading size="small" /> 正在比对…
          </div>
        ) : !hasAnything ? (
          <div
            className="flex items-center gap-2 py-6 justify-center"
            style={{ color: '#6ee7b7' }}
          >
            <CheckCircle2 size={16} />
            两边已经一致，没有需要处理的差异
          </div>
        ) : (
          <>
            {/* ① 重复路径 */}
            {duplicates.length > 0 && (
              <section className="ws-sync-block ws-sync-block--danger">
                <div className="ws-sync-title">
                  <Combine size={14} />
                  同路径重复：{duplicates.length} 组
                </div>
                <div className="ws-sync-desc">
                  同一个目录挂了多个工作空间 —— 这不只是显示问题：调度互锁按工作空间分组，
                  重复会让<b>同一目录可以被并行修改</b>。合并是安全的（任务会改指保留项，不丢任务）。
                </div>
                <ul className="ws-sync-list">
                  {duplicates.slice(0, 6).map(d => (
                    <li key={d.key}>
                      <span className="font-mono truncate" title={d.path}>
                        {d.path}
                      </span>
                      <span style={{ color: '#fbbf24' }}> ×{d.count}</span>
                      <span style={{ color: '#64748b' }}>
                        {' '}
                        · 保留「{d.keepName}」，合并掉 {d.dropIds.length} 条 · 涉及 {d.taskCount} 个任务
                      </span>
                    </li>
                  ))}
                  {duplicates.length > 6 && (
                    <li style={{ color: '#64748b' }}>…还有 {duplicates.length - 6} 组</li>
                  )}
                </ul>
                <Button
                  size="small"
                  theme="warning"
                  variant="outline"
                  loading={applying}
                  onClick={() => void run({ mergeDuplicates: true }, '已合并重复')}
                >
                  合并重复路径
                </Button>
              </section>
            )}

            {/* ② 仅宿主有 */}
            {onlyHost.length > 0 && (
              <section className="ws-sync-block">
                <div className="ws-sync-title">
                  <Download size={14} />
                  WorkBuddy 有、看板没有：{onlyHost.length} 个
                </div>
                <ul className="ws-sync-list">
                  {onlyHost.slice(0, 6).map(h => (
                    <li key={h.path}>
                      <span className="font-mono truncate" title={h.path}>
                        {h.path}
                      </span>
                    </li>
                  ))}
                  {onlyHost.length > 6 && (
                    <li style={{ color: '#64748b' }}>…还有 {onlyHost.length - 6} 个</li>
                  )}
                </ul>
                <Button
                  size="small"
                  theme="primary"
                  variant="outline"
                  loading={applying}
                  onClick={() => void run({ importMissing: true }, '已导入缺失空间')}
                >
                  导入这 {onlyHost.length} 个
                </Button>
              </section>
            )}

            {/* ③ 仅看板有 */}
            {onlyBoard.length > 0 && (
              <section className="ws-sync-block">
                <div className="ws-sync-title">
                  <Trash2 size={14} />
                  看板有、WorkBuddy 没有：{onlyBoard.length} 个
                </div>
                <div className="ws-sync-desc">
                  这些可能是<b>特别原因</b>（例如看板自己的项目目录、临时验收目录），
                  也可能是历史残留。目录已不存在的通常是残留，可以放心移除。
                </div>
                <ul className="ws-sync-list ws-sync-list--pick">
                  {onlyBoard.map(w => (
                    <li key={w.id}>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={removeIds.has(w.id)}
                          onChange={() => toggle(w.id)}
                          style={{ marginTop: 3 }}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5 flex-wrap">
                            <b style={{ color: '#e2e8f0' }}>{w.name}</b>
                            {w.pathExists ? (
                              <span className="ws-sync-pill" style={{ color: '#94a3b8' }}>
                                <FolderOpen size={10} /> 目录存在
                              </span>
                            ) : (
                              <span className="ws-sync-pill" style={{ color: '#fca5a5' }}>
                                <FolderX size={10} /> 目录已不存在
                              </span>
                            )}
                            <span className="ws-sync-pill" style={{ color: w.taskCount ? '#fbbf24' : '#64748b' }}>
                              {w.taskCount} 个任务引用
                            </span>
                          </span>
                          <span className="block font-mono truncate" style={{ color: '#64748b' }} title={w.path}>
                            {w.path}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>

                {needReassign && (
                  <div className="ws-sync-reassign">
                    <div className="flex items-center gap-1.5 mb-1.5" style={{ color: '#fbbf24' }}>
                      <AlertTriangle size={12} />
                      选中的空间仍被任务引用（{[...selectedReferenced].length} 个，共{' '}
                      {selectedReferenced.reduce((n, w) => n + w.taskCount, 0)} 个任务）
                    </div>
                    <div className="text-[13px] mb-2" style={{ color: '#94a3b8' }}>
                      选择要把这些任务改挂到的空间；<b>不选则这些空间不会被删除</b>
                      （只删没有任务引用的那些）。
                    </div>
                    <Select
                      size="small"
                      clearable
                      value={reassignTo}
                      onChange={v => setReassignTo(String(v ?? ''))}
                      placeholder="选择改挂目标（可选）"
                      options={workspaces
                        .filter(w => !removeIds.has(w.id))
                        .map(w => ({ label: `${w.name}（${w.path}）`, value: w.id }))}
                    />
                  </div>
                )}

                <Button
                  size="small"
                  theme="danger"
                  variant="outline"
                  disabled={removeIds.size === 0}
                  loading={applying}
                  onClick={() =>
                    void run(
                      {
                        removeIds: [...removeIds],
                        reassignTo: needReassign && reassignTo ? reassignTo : undefined,
                      },
                      '已移除选中空间'
                    )
                  }
                >
                  移除选中的 {removeIds.size} 个
                </Button>
                {needReassign && !reassignTo && (
                  <span className="text-[13px] ml-2" style={{ color: '#94a3b8' }}>
                    （未选改挂目标 → 有任务引用的会被跳过）
                  </span>
                )}
              </section>
            )}
          </>
        )}

        <div className="text-[13px] leading-relaxed" style={{ color: '#64748b' }}>
          <b style={{ color: '#94a3b8' }}>WorkBuddy 数据始终只读</b>
          ：这里只改看板自己的库。删除工作空间不会删除任何文件，也不会删除任务
          （选了改挂目标时，任务会转到另一个空间上）。
        </div>
      </div>
    </Dialog>
  );
};

export default WorkspaceSyncDialog;
