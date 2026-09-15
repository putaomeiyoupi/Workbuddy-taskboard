/**
 * WorkspaceManager —— 工作空间与调度参数配置
 *
 * 这里是调度策略的可调面板：
 *  - 每个工作空间可单独配置 `max_concurrency`（空间内并发上限，默认 1 = 串行互锁）
 *  - 全局并发上限影响跨工作空间的并行度
 */

import React, { useState } from 'react';
import {
  Dialog,
  Input,
  InputNumber,
  Button,
  MessagePlugin,
  Popconfirm,
} from 'tdesign-react';
import { Plus, Trash2, Save, Puzzle, Cpu, Zap, Pencil } from 'lucide-react';
import type { Workspace, SchedulerStatus } from '../../types';

interface WorkspaceManagerProps {
  visible: boolean;
  onClose: () => void;
  workspaces: Workspace[];
  status: SchedulerStatus | null;
  onCreate: (payload: {
    name: string;
    path: string;
    max_concurrency?: number;
    description?: string;
    color?: string;
  }) => Promise<unknown>;
  onUpdate: (
    id: string,
    patch: Partial<Pick<Workspace, 'name' | 'path' | 'max_concurrency' | 'description' | 'color'>>
  ) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onUpdateGlobalConcurrency: (n: number) => Promise<void>;
  /** 打开「与 WorkBuddy 对齐」对话框（查看差异后再决定导入/移除） */
  onOpenSync?: () => void;
}

const PRESET_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#60a5fa'];

export const WorkspaceManager: React.FC<WorkspaceManagerProps> = ({
  visible,
  onClose,
  workspaces,
  status,
  onCreate,
  onUpdate,
  onDelete,
  onUpdateGlobalConcurrency,
  onOpenSync,
}) => {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newConcurrency, setNewConcurrency] = useState(1);
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Workspace>>({});
  const [globalConc, setGlobalConc] = useState<number>(status?.globalConcurrency ?? 3);

  React.useEffect(() => {
    if (visible && status) setGlobalConc(status.globalConcurrency);
  }, [visible, status]);

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) {
      MessagePlugin.warning('名称与路径均为必填');
      return;
    }
    await onCreate({
      name: newName.trim(),
      path: newPath.trim().replace(/\\/g, '/'),
      max_concurrency: newConcurrency,
      color: newColor,
    });
    setNewName('');
    setNewPath('');
    setNewConcurrency(1);
    setCreating(false);
    MessagePlugin.success('工作空间已创建');
  };

  const startEdit = (ws: Workspace) => {
    setEditingId(ws.id);
    setEditDraft({
      name: ws.name,
      path: ws.path,
      max_concurrency: ws.max_concurrency,
      color: ws.color || PRESET_COLORS[0],
      description: ws.description,
    });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    await onUpdate(editingId, editDraft as any);
    setEditingId(null);
    setEditDraft({});
    MessagePlugin.success('已保存');
  };

  const totalCapacity = workspaces.reduce((sum, w) => sum + w.max_concurrency, 0);
  const globalRunning = status?.globalRunning ?? 0;

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      header="工作空间与调度参数"
      width={720}
      footer={
        <div className="flex items-center justify-between gap-2">
          {/* 与宿主对齐：两边工作空间应保持一致（除非用户明确要保留本地额外空间） */}
          {onOpenSync ? (
            <Button
              variant="outline"
              size="small"
              onClick={onOpenSync}
              title="查看与 WorkBuddy 的工作空间差异，再决定导入或移除"
            >
              与 WorkBuddy 对齐…
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {/* 调度参数概览 */}
        <div
          className="rounded-lg p-3.5"
          style={{ background: 'rgba(167, 139, 250, 0.06)', border: '1px solid rgba(167,139,250,0.20)' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Cpu size={13} style={{ color: '#a78bfa' }} />
            <span className="text-xs font-semibold" style={{ color: '#c4b5fd' }}>
              调度参数（WSML-P 策略）
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[13.5px] mb-1.5" style={{ color: '#94a3b8' }}>
                全局并发上限
                <span className="opacity-60 ml-1">（跨所有工作空间同时运行的任务数）</span>
              </label>
              <div className="flex items-center gap-2">
                <InputNumber
                  value={globalConc}
                  onChange={v => setGlobalConc(Number(v) || 1)}
                  min={1}
                  max={16}
                  style={{ width: 110 }}
                />
                <Button
                  size="small"
                  variant="outline"
                  icon={<Save size={12} />}
                  onClick={async () => {
                    await onUpdateGlobalConcurrency(globalConc);
                    MessagePlugin.success(`全局并发已设为 ${globalConc}`);
                  }}
                >
                  应用
                </Button>
              </div>
            </div>

            <div className="text-[13.5px] flex flex-col justify-center gap-1.5">
              <div className="flex items-center justify-between">
                <span style={{ color: '#94a3b8' }}>当前运行中</span>
                <span className="stat-value" style={{ color: '#a78bfa' }}>
                  {globalRunning} / {globalConc}
                </span>
              </div>
              <div className="slot-track">
                {Array.from({ length: Math.max(globalConc, 1) }).map((_, i) => (
                  <span
                    key={i}
                    className={`slot-cell ${i < globalRunning ? 'slot-cell--filled' : ''}`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between mt-1">
                <span style={{ color: '#94a3b8' }}>理论最大并行度</span>
                <span className="stat-value" style={{ color: '#c4b5fd' }}>
                  {Math.min(totalCapacity, globalConc)}
                </span>
              </div>
            </div>
          </div>

          <div
            className="mt-3 pt-3 text-[13px] font-mono leading-relaxed"
            style={{ borderTop: '1px solid rgba(167,139,250,0.15)', color: '#64748b' }}
          >
            调度顺序：定时任务到点 → 按优先级降序扫描待办 → 逐个检查
            <span style={{ color: '#67e8f9' }}> 依赖满足 </span>→
            <span style={{ color: '#67e8f9' }}> 工作空间互锁 </span>→
            <span style={{ color: '#67e8f9' }}> 全局槽位 </span>→ 启动执行
          </div>
        </div>

        {/* 工作空间列表 */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <Puzzle size={13} style={{ color: '#22d3ee' }} />
              <span className="text-xs font-semibold" style={{ color: '#a5f3fc' }}>
                工作空间（{workspaces.length}）
              </span>
            </div>
            <Button
              size="small"
              variant="outline"
              icon={<Plus size={12} />}
              onClick={() => setCreating(v => !v)}
            >
              {creating ? '收起' : '新建'}
            </Button>
          </div>

          {/* 新建表单 */}
          {creating && (
            <div
              className="rounded-md p-3 mb-3 grid gap-2.5"
              style={{ background: 'rgba(34,211,238,0.05)', border: '1px solid rgba(34,211,238,0.20)' }}
            >
              <div className="grid grid-cols-2 gap-2.5">
                <Input
                  value={newName}
                  onChange={v => setNewName(String(v))}
                  placeholder="名称，例如：sunshinerose 仓库"
                />
                <Input
                  value={newPath}
                  onChange={v => setNewPath(String(v))}
                  placeholder="路径，例如：E:/SunshineRose/sunshinerose"
                />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px]" style={{ color: '#94a3b8' }}>
                    空间内并发
                  </span>
                  <InputNumber
                    value={newConcurrency}
                    onChange={v => setNewConcurrency(Number(v) || 1)}
                    min={1}
                    max={8}
                    style={{ width: 90 }}
                    size="small"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[13.5px]" style={{ color: '#94a3b8' }}>
                    标记色
                  </span>
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setNewColor(c)}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        background: c,
                        border: newColor === c ? '2px solid #fff' : '2px solid transparent',
                        boxShadow: newColor === c ? `0 0 8px ${c}` : 'none',
                        cursor: 'pointer',
                      }}
                      aria-label={`选择颜色 ${c}`}
                    />
                  ))}
                </div>
                <Button size="small" theme="primary" onClick={handleCreate} className="ml-auto">
                  创建
                </Button>
              </div>
            </div>
          )}

          {/* 列表 */}
          <div className="flex flex-col gap-2 max-h-[280px] overflow-y-auto pr-1">
            {workspaces.length === 0 ? (
              <div
                className="text-[13.5px] font-mono py-6 text-center rounded-md"
                style={{ color: '#475569', border: '1px dashed rgba(120,170,230,0.18)' }}
              >
                // 尚无工作空间，请先创建一个
              </div>
            ) : (
              workspaces.map(ws => {
                const isEditing = editingId === ws.id;

                return (
                  <div
                    key={ws.id}
                    className="rounded-md px-3 py-2.5"
                    style={{
                      background: 'rgba(255,255,255,0.025)',
                      border: `1px solid ${
                        isEditing ? 'rgba(34,211,238,0.35)' : 'var(--hairline)'
                      }`,
                    }}
                  >
                    {isEditing ? (
                      <div className="grid gap-2.5">
                        <div className="grid grid-cols-2 gap-2.5">
                          <Input
                            value={String(editDraft.name ?? '')}
                            onChange={v => setEditDraft(d => ({ ...d, name: String(v) }))}
                            placeholder="名称"
                            size="small"
                          />
                          <Input
                            value={String(editDraft.path ?? '')}
                            onChange={v => setEditDraft(d => ({ ...d, path: String(v) }))}
                            placeholder="路径"
                            size="small"
                          />
                        </div>
                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="text-[13.5px]" style={{ color: '#94a3b8' }}>
                              空间内并发
                            </span>
                            <InputNumber
                              value={Number(editDraft.max_concurrency ?? 1)}
                              onChange={v =>
                                setEditDraft(d => ({ ...d, max_concurrency: Number(v) || 1 }))
                              }
                              min={1}
                              max={8}
                              size="small"
                              style={{ width: 90 }}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            {PRESET_COLORS.map(c => (
                              <button
                                key={c}
                                onClick={() => setEditDraft(d => ({ ...d, color: c }))}
                                style={{
                                  width: 16,
                                  height: 16,
                                  borderRadius: 3,
                                  background: c,
                                  border:
                                    editDraft.color === c
                                      ? '2px solid #fff'
                                      : '2px solid transparent',
                                  cursor: 'pointer',
                                }}
                                aria-label={`颜色 ${c}`}
                              />
                            ))}
                          </div>
                          <div className="ml-auto flex gap-2">
                            <Button size="small" variant="outline" onClick={() => setEditingId(null)}>
                              取消
                            </Button>
                            <Button size="small" theme="primary" onClick={saveEdit}>
                              保存
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: ws.color || '#22d3ee',
                            boxShadow: `0 0 8px ${ws.color || '#22d3ee'}`,
                            flexShrink: 0,
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <div
                            className="text-[15px] font-medium truncate"
                            style={{ color: '#e6edf7' }}
                          >
                            {ws.name}
                          </div>
                          <div
                            className="text-[13px] font-mono truncate"
                            style={{ color: '#64748b' }}
                            title={ws.path}
                          >
                            {ws.path}
                          </div>
                        </div>
                        <span
                          className="task-chip task-chip--accent shrink-0"
                          style={{ '--chip-color': ws.color || '#22d3ee' } as React.CSSProperties}
                          title="该工作空间内允许同时运行的任务数"
                        >
                          <Zap size={9} />
                          并发 {ws.max_concurrency}
                        </span>
                        <button
                          className="board-toolbar-btn !h-7 !px-2 shrink-0"
                          onClick={() => startEdit(ws)}
                          aria-label="编辑"
                        >
                          <Pencil size={12} />
                        </button>
                        <Popconfirm
                          content="删除后该空间下的任务将无法执行。确认删除？"
                          onConfirm={() => onDelete(ws.id)}
                        >
                          <button
                            className="board-toolbar-btn !h-7 !px-2 shrink-0"
                            aria-label="删除"
                          >
                            <Trash2 size={12} />
                          </button>
                        </Popconfirm>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
};

export default WorkspaceManager;
