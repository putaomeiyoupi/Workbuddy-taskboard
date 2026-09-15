/**
 * TaskBoard —— 四列看板主体
 *
 * 动画策略：
 *  - 卡片跨列移动用 FLIP：变动前列位置 → 变动后列位置 → 反向变换回原位 → 播放过渡
 *    这样即便 React 重建 DOM，视觉上也是平滑飞行而非瞬移
 *  - 刚移动的卡片叠加 `task-card--landed` 高亮脉冲
 *  - 新增卡片叠加入场动画
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Task, BoardColumnKey } from '../../types';
import { BOARD_COLUMNS, columnOf, isActive, type BoardColumnConfig } from './boardConfig';
import { BoardColumn } from './BoardColumn';

interface TaskBoardProps {
  tasks: Task[];
  selectedTaskId: string | null;
  getBlockedBy?: (task: Task) => string[];
  onSelectTask: (task: Task) => void;
  /** 卡片被拖放到某一列 */
  onMoveTask: (task: Task, targetColumn: BoardColumnKey) => void;
  /** 宿主（WorkBuddy）只读卡片，按板块 key 分发 */
  hostCards?: Partial<Record<BoardColumnKey, React.ReactNode>>;
  /** 宿主卡片数量，按板块 key 计数 */
  hostCounts?: Partial<Record<BoardColumnKey, number>>;
}

/** FLIP 过渡时长（须与 CSS 中的过渡一致） */
const FLIP_DURATION_MS = 420;

export const TaskBoard: React.FC<TaskBoardProps> = ({
  tasks,
  selectedTaskId,
  getBlockedBy,
  onSelectTask,
  onMoveTask,
  hostCards,
  hostCounts,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** 上一次渲染时每个卡片的位置快照（FLIP 的 First） */
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);
  const [landedIds, setLandedIds] = useState<Set<string>>(new Set());
  const [enterIds, setEnterIds] = useState<Set<string>>(new Set());

  /** 记录当前所有卡片位置 */
  const snapshotPositions = useCallback(() => {
    const map = new Map<string, DOMRect>();
    const root = containerRef.current;
    if (!root) return map;
    root.querySelectorAll<HTMLElement>('[data-task-id]').forEach(el => {
      const id = el.dataset.taskId;
      if (id) map.set(id, el.getBoundingClientRect());
    });
    return map;
  }, []);

  // 布局变更后执行 FLIP 动画
  useLayoutEffect(() => {
    const root = containerRef.current;
    const prev = prevRectsRef.current;
    const next = snapshotPositions();

    if (prev.size > 0) {
      next.forEach((newRect, id) => {
        const oldRect = prev.get(id);
        if (!oldRect) {
          // 新出现的卡片 → 入场动画
          setEnterIds(prev => new Set(prev).add(id));
          setTimeout(() => {
            setEnterIds(cur => {
              const copy = new Set(cur);
              copy.delete(id);
              return copy;
            });
          }, 400);
          return;
        }

        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // 位置未变

        const el = root?.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
        if (!el) return;

        // Invert：先瞬移回旧位置
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;

        // Play：下一帧释放，交给 CSS 过渡飞回新位置
        requestAnimationFrame(() => {
          el.style.transition = `transform ${FLIP_DURATION_MS}ms cubic-bezier(0.2, 0.85, 0.25, 1)`;
          el.style.transform = '';

          // 落地高亮
          setLandedIds(cur => new Set(cur).add(id));
          setTimeout(() => {
            setLandedIds(cur => {
              const copy = new Set(cur);
              copy.delete(id);
              return copy;
            });
          }, FLIP_DURATION_MS + 100);

          // 过渡结束后清理内联样式，避免影响后续 hover 变换
          setTimeout(() => {
            el.style.transition = '';
            el.style.transform = '';
          }, FLIP_DURATION_MS + 60);
        });
      });
    }

    prevRectsRef.current = next;
  }, [tasks, snapshotPositions]);

  /** 拖放：判定目标列是否合法 */
  const handleDropTask = useCallback(
    (taskId: string, column: BoardColumnConfig) => {
      setDraggingTask(null);
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;

      if (columnOf(task) === column.key) return; // 同列，忽略

      // 进行中的任务不允许拖出（必须先取消）
      if (isActive(task)) {
        console.warn('[Board] 进行中的任务不能拖动，请先取消');
        return;
      }

      onMoveTask(task, column.key);
    },
    [tasks, onMoveTask]
  );

  /**
   * 列数跟随 BOARD_COLUMNS（新增「已完成」后为 5 列），避免硬编码 4 导致漏改。
   *
   * ⚠️ `gridTemplateRows: minmax(0, 1fr)` 是**必需**的：
   * 网格的隐式行默认以 `auto`（= 内容高度）为下限，列里卡片一多，整行就被撑高 ——
   * 实测 88 张卡片会把整块看板撑到 9000px，而外层是 `overflow:hidden`，
   * 于是**下半部分既看不到也滚不动**（用户报的「超过屏幕时应该能上下滚动」就是这个）。
   * 用 `minmax(0, 1fr)` 把行的下限压到 0，列高才会受限于视口，
   * 由列体自身（`.board-column-body { overflow-y:auto }`）来滚动。
   */
  const gridStyle: React.CSSProperties = {
    /**
     * ⚠️ 列宽下限 280px，是用户要求的「卡片缩到刚好能显示完全内容为止」：
     * 再窄下去标题/元信息会被截断，此时**该出现的是横向滚动条，而不是把卡片压扁**。
     * 上限仍是 1fr（宽屏时铺满）；下限一到，网格内容就会超出容器宽度，
     * 由外层（BoardPage 的看板区 `overflow-x:auto`）给出横向滚动。
     */
    gridTemplateColumns: `repeat(${BOARD_COLUMNS.length}, minmax(280px, 1fr))`,
    gridTemplateRows: 'minmax(0, 1fr)',
  };

  return (
    <div ref={containerRef} className="grid gap-3 flex-1 min-h-0 w-full px-4 pb-4" style={gridStyle}>
      {BOARD_COLUMNS.map(column => {
        const columnTasks = tasks
          .filter(column.match)
          .sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
            return a.created_at.localeCompare(b.created_at);
          });

        return (
          <div key={column.key} className="min-h-0 h-full" data-column={column.key}>
            <BoardColumn
              column={column}
              tasks={columnTasks}
              selectedTaskId={selectedTaskId}
              landedIds={landedIds}
              enterIds={enterIds}
              getBlockedBy={column.key === 'todo' ? getBlockedBy : undefined}
              onSelectTask={onSelectTask}
              onDragStartTask={setDraggingTask}
              onDragEndTask={() => setDraggingTask(null)}
              onDropTask={handleDropTask}
              hostCards={hostCards?.[column.key]}
              hostCount={hostCounts?.[column.key] ?? 0}
            />
          </div>
        );
      })}

      {/* 拖拽中的全局提示 */}
      {draggingTask && (
        <div
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[1400] px-3.5 py-2 rounded-md text-[14px] font-mono pointer-events-none"
          style={{
            background: 'rgba(9, 13, 23, 0.94)',
            border: '1px solid rgba(120, 170, 230, 0.28)',
            color: '#93c5fd',
            boxShadow: '0 8px 28px -8px rgba(0,0,0,0.9)',
          }}
        >
          拖动「{draggingTask.title}」到目标板块以调整状态
        </div>
      )}
    </div>
  );
};

export default TaskBoard;
