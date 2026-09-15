/**
 * BoardColumn —— 看板单列
 *
 * 支持拖拽放入：拖动任务卡片到列上时高亮，放下后由父级判定合法性。
 */

import React, { useState } from 'react';
import type { Task } from '../../types';
import { isActive, type BoardColumnConfig } from './boardConfig';
import { TaskCard } from './TaskCard';

interface BoardColumnProps {
  column: BoardColumnConfig;
  tasks: Task[];
  selectedTaskId: string | null;
  landedIds: Set<string>;
  enterIds: Set<string>;
  /** 计算某个任务被哪些前置任务阻塞（仅 todo 列用到） */
  getBlockedBy?: (task: Task) => string[];
  onSelectTask: (task: Task) => void;
  onDragStartTask: (task: Task) => void;
  onDragEndTask: () => void;
  onDropTask: (taskId: string, column: BoardColumnConfig) => void;
  /** 宿主（WorkBuddy）只读卡片，渲染在本列看板任务之后 */
  hostCards?: React.ReactNode;
  /** 宿主卡片数量，用于列头计数 */
  hostCount?: number;
}

export const BoardColumn: React.FC<BoardColumnProps> = ({
  column,
  tasks,
  selectedTaskId,
  landedIds,
  enterIds,
  getBlockedBy,
  onSelectTask,
  onDragStartTask,
  onDragEndTask,
  onDropTask,
  hostCards,
  hostCount = 0,
}) => {
  const [dropActive, setDropActive] = useState(false);
  const total = tasks.length + hostCount;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dropActive) setDropActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // 只有真正离开列容器才取消高亮（避免子元素冒泡误触发）
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) onDropTask(taskId, column);
  };

  return (
    <div
      // h-full：铺满外层网格行（行高已被 minmax(0,1fr) 压到视口内），
      // 这样列体才能成为唯一的滚动区，而不是把整页撑高
      className={`board-column h-full ${dropActive ? 'board-column--drop-active' : ''}`}
      style={
        {
          '--col-accent': column.accent,
          '--col-accent-dim': column.accentDim,
        } as React.CSSProperties
      }
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 列头 */}
      <div className="board-column-header">
        <div className="board-column-title">
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: column.accent,
              boxShadow: `0 0 6px ${column.accent}`,
              display: 'inline-block',
            }}
          />
          <span>{column.title}</span>
          <span
            className="text-[12px] font-mono opacity-45 tracking-widest font-normal"
            style={{ letterSpacing: '0.16em' }}
          >
            {column.subtitle}
          </span>
        </div>
        <span className="board-count">{String(total).padStart(2, '0')}</span>
      </div>

      {/* 列内容 */}
      <div className="board-column-body">
        {total === 0 ? (
          <div className="board-empty">
            <span>// 空</span>
            <span className="text-[12.5px] opacity-60">{column.description}</span>
          </div>
        ) : (
          <>
            {tasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                selected={selectedTaskId === task.id}
                landed={landedIds.has(task.id)}
                enter={enterIds.has(task.id)}
                blockedBy={getBlockedBy ? getBlockedBy(task) : undefined}
                onSelect={onSelectTask}
                onDragStart={onDragStartTask}
                onDragEnd={onDragEndTask}
                draggable={!isActive(task)}
              />
            ))}
            {hostCards}
          </>
        )}
      </div>
    </div>
  );
};

export default BoardColumn;
