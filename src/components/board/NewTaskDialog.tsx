/**
 * NewTaskDialog —— 新建任务
 *
 * 关键能力（对应需求）：
 *  - 选择不同的工作空间（决定执行目录 + 参与调度互锁）
 *  - 指定不同的模型
 *  - 设置优先级（影响调度顺序）
 *  - 设置定时时间（落入「自动化定时」板块）
 *  - 选择前置依赖任务（影响能否启动）
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Dialog, Input, Textarea, Select, Button, MessagePlugin } from 'tdesign-react';
import { Clock, GitBranch, Puzzle, Cpu, Zap, Files } from 'lucide-react';
import type { Model, Workspace, Task, NewTaskPayload, TaskPriority, TaskExecutor, RepeatMode, RepeatSpec } from '../../types';
import { isExecuting } from './boardConfig';

/** 优先级选项 */
const PRIORITY_OPTIONS: Array<{ value: TaskPriority; label: string; color: string }> = [
  { value: 0, label: '低', color: '#94a3b8' },
  { value: 1, label: '中', color: '#38bdf8' },
  { value: 2, label: '高', color: '#f43f5e' },
];

/**
 * ⚠️ 原先这里有一组「执行隔离」选项（共享目录 / 独立工作树）。
 *     已整组删除，原因：
 *       ① `worktree` 早已不可用 —— 服务端对 `isolation: 'worktree'` 直接返回 400；
 *       ② 更关键的是，服务端创建任务时把 `isolation` **写死为 `'shared'`**
 *          （见 `server/index.ts` 的 create 分支），客户端传什么都一样 ⇒ 这组控件是死的；
 *       ③ 只剩「共享目录」一个有效值，摆一个单选项只会增加理解成本。
 *     任务与同空间其他任务的关系恒为：**就地修改 + 工作空间互锁（串行）**。
 */

/** 执行者选项 */
interface ExecutorOption {
  value: TaskExecutor;
  label: string;
  hint: string;
  color: string;
  /** 当前环境不可用：禁用选择并说明原因 */
  disabled?: boolean;
  badge?: string;
}

/**
 * 构造执行器选项。
 *
 * ⚠️ 原先还有「WorkBuddy（交给宿主执行）」一项，**该执行器已下线**
 * ⇒ 现在只剩本地执行器。
 * 「本地」是否可选仍由后端探测的 SDK 可用性决定。
 */
function buildExecutorOptions(sdkUnavailable: boolean, sdkReason?: string | null): ExecutorOption[] {
  return [
    {
      value: 'local',
      label: '本地',
      hint: sdkUnavailable
        ? `由看板自身调度器执行（本机 Agent SDK 不可用：${sdkReason ?? '初始化失败'}）`
        : '由看板自身调度器执行，工作空间互锁生效',
      color: '#22d3ee',
      disabled: sdkUnavailable,
      badge: sdkUnavailable ? '暂不可用' : undefined,
    },
  ];
}

/**
 * 模型清单来源 → 中文说明。
 * `workbuddy-config` 是理想状态（读的是桌面端同一份产品配置）；
 * 其余都属于回落，必须显式告诉用户「可能和 WorkBuddy 不一致」。
 */
const MODEL_SOURCE_HINT: Record<string, string> = {
  'workbuddy-config': '与 WorkBuddy 同源（读的是桌面端同一份配置）',
  'models-json': '来自 ~/.workbuddy/models.json（自定义模型）',
  sdk: '来自 Agent SDK（回落）',
  'host-observed': '回落：宿主机历史用过的模型',
  fallback: '回落：仅默认模型',
};

interface NewTaskDialogProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (payload: NewTaskPayload) => Promise<unknown>;
  workspaces: Workspace[];
  models: Model[];
  /** 模型清单来源（/api/models 的 source 字段） */
  modelSource?: string;
  tasks: Task[];
  defaultModel: string;
  defaultWorkspaceId?: string | null;
  /** 预填的工作空间（例如从某列的空状态点进来） */
  /** 本机 Agent SDK 是否不可用（决定「本地」执行器能否选） */
  sdkUnavailable?: boolean;
  /** 不可用原因，展示在提示里 */
  sdkReason?: string | null;
}

/** datetime-local 输入需要本地时区的 YYYY-MM-DDTHH:mm */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export const NewTaskDialog: React.FC<NewTaskDialogProps> = ({
  visible,
  onClose,
  onConfirm,
  workspaces,
  models,
  modelSource,
  tasks,
  defaultModel,
  defaultWorkspaceId,
  sdkUnavailable = false,
  sdkReason = null,
}) => {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(defaultWorkspaceId ?? null);
  const [model, setModel] = useState(defaultModel);
  const [priority, setPriority] = useState<TaskPriority>(1);
  const [useSchedule, setUseSchedule] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  /**
   * 定时方式：一次 / 周期 / 间隔。
   *
   * 为什么不用 `repeat_mode` 直接当状态：界面上「只执行一次」对应
   * `repeat_mode='none'` **且**必须填时间，与「不勾选定时」是两回事
   * （后者是纯待办任务）。用一个独立字段表达更不容易搞混。
   */
  const [schedKind, setSchedKind] = useState<'once' | 'periodic' | 'interval'>('once');
  /** 周期：频率与时刻 */
  const [pFreq, setPFreq] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [pTime, setPTime] = useState('08:00');
  const [pDays, setPDays] = useState<number[]>([1]);
  const [pDom, setPDom] = useState(1);
  /** 间隔：每 N 个时间单位 */
  const [iEvery, setIEvery] = useState(1);
  const [iUnit, setIUnit] = useState<'minute' | 'hour' | 'day'>('hour');
  /** 循环的公共约束（可选） */
  const [untilAt, setUntilAt] = useState('');
  const [limitCount, setLimitCount] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  /** 修改范围输入（每行一个仓库内相对路径） */
  const [scopesInput, setScopesInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** 执行者：只剩本地（workbuddy 执行器已下线） */
  const [executor, setExecutor] = useState<TaskExecutor>('local');
  /**
   * 按执行者拉取的模型清单。
   * 「看板里能选的模型」必须与「该执行者真正能用的模型」一致 ——
   * 交给 WorkBuddy 时用产品配置那份，本地 SDK 执行时用 SDK 那份，两者不通用。
   */
  const [executorModels, setExecutorModels] = useState<{
    models: Model[];
    source: string;
    reason?: string;
  } | null>(null);
  /** 是否展开「全部模型」（默认只列常用，避免 50+ 项淹没） */
  const [showAllModels, setShowAllModels] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/models?executor=${executor}`);
        const data = await r.json();
        if (cancelled) return;
        setExecutorModels({
          models: Array.isArray(data?.models) ? data.models : [],
          source: typeof data?.source === 'string' ? data.source : '',
          reason: typeof data?.reason === 'string' ? data.reason : undefined,
        });
      } catch {
        if (!cancelled) setExecutorModels(null); // 失败就沿用外部传入的清单
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, executor]);

  // 打开时重置 & 应用默认值
  useEffect(() => {
    if (!visible) return;
    setTitle('');
    setPrompt('');
    setWorkspaceId(defaultWorkspaceId ?? workspaces[0]?.id ?? null);
    setModel(defaultModel || models[0]?.modelId || '');
    setPriority(1);
    setUseSchedule(false);
    const dt = new Date(Date.now() + 30 * 60 * 1000);
    dt.setSeconds(0, 0);
    setScheduledAt(toLocalInputValue(dt));
    setDependsOn([]);
    setSubmitting(false);
    setExecutor('local');
    setScopesInput('');
  }, [visible, defaultWorkspaceId, workspaces, defaultModel, models]);

  // 可选依赖：排除自己、正在运行、已完成/已取消的任务
  const dependencyOptions = useMemo(
    () =>
      tasks
        .filter(t => t.status !== 'done' && t.status !== 'cancelled')
        .map(t => ({
          label: `[${isExecuting(t) ? '进行中' : t.status === 'scheduled' ? '定时' : '待办'}] ${t.title}`,
          value: t.id,
        })),
    [tasks]
  );

  const workspaceOptions = useMemo(
    () =>
      workspaces.map(ws => ({
        label: ws.name,
        value: ws.id,
      })),
    [workspaces]
  );

  /** 执行者对应的清单；拉取失败时回落到外部传入的（App 级）清单 */
  const activeModels = executorModels?.models?.length ? executorModels.models : models;
  const activeSource = executorModels?.source || modelSource || '';

  /**
   * 真正列出来的候选：默认只给「常用」（档位 + craft + 自定义 + 本机跑过的），
   * 点「显示全部」才展开 —— 直接铺 50+ 项没人选得动。
   */
  const visibleModels = useMemo(() => {
    if (showAllModels) return activeModels;
    const recommended = activeModels.filter(m => (m as Model & { recommended?: boolean }).recommended);
    return recommended.length > 0 ? recommended : activeModels;
  }, [activeModels, showAllModels]);

  const modelOptions = useMemo(
    () =>
      visibleModels.map(m => ({
        label: m.name || m.modelId,
        value: m.modelId,
      })),
    [visibleModels]
  );

  /**
   * 切执行者后，原先选的模型可能不在新清单里（两份清单本就不同）。
   * 这时**只做必要的回退** —— 用户手选过的、且仍然可用的选项不要动。
   */
  useEffect(() => {
    if (!visible || activeModels.length === 0) return;
    if (activeModels.some(m => m.modelId === model)) return;
    const fallback =
      defaultModel && activeModels.some(m => m.modelId === defaultModel)
        ? defaultModel
        : activeModels[0].modelId;
    setModel(fallback);
  }, [visible, activeModels, defaultModel, model]);

  const handleSubmit = async () => {
    if (!title.trim()) {
      MessagePlugin.warning('请填写任务标题');
      return;
    }
    if (!prompt.trim()) {
      MessagePlugin.warning('请填写任务描述（将作为指令交给 Agent 执行）');
      return;
    }
    if (useSchedule && schedKind === 'once' && !scheduledAt) {
      MessagePlugin.warning('请选择执行时间');
      return;
    }
    if (useSchedule && schedKind === 'periodic' && pFreq === 'weekly' && pDays.length === 0) {
      MessagePlugin.warning('请至少选择一个星期几');
      return;
    }
    if (useSchedule && schedKind === 'interval' && (!Number.isInteger(iEvery) || iEvery < 1)) {
      MessagePlugin.warning('间隔必须是大于 0 的整数');
      return;
    }
    if (useSchedule && limitCount.trim()) {
      const n = Number(limitCount);
      if (!Number.isInteger(n) || n < 1) {
        MessagePlugin.warning('最多执行次数必须是大于 0 的整数');
        return;
      }
    }

    /**
     * 组装循环规格。
     * ⚠️ `scheduled_at` 只在**用户明确填了**时才传（作为"首次执行"覆盖）；
     *    留空则传 null，由服务端按规格从当前时间往后算 —— 算法只在服务端有一份，
     *    前端自己算会出现「界面预览与实际触发不一致」。
     */
    const [ph, pm] = pTime.split(':').map(Number);
    const repeat_mode: RepeatMode = !useSchedule ? 'none' : schedKind === 'once' ? 'none' : schedKind;
    const repeat_spec: RepeatSpec | null =
      !useSchedule || schedKind === 'once'
        ? null
        : schedKind === 'periodic'
          ? pFreq === 'weekly'
            ? { freq: 'weekly', hour: ph, minute: pm, byDay: [...pDays].sort((a, b) => a - b) }
            : pFreq === 'monthly'
              ? { freq: 'monthly', hour: ph, minute: pm, byMonthDay: pDom }
              : { freq: 'daily', hour: ph, minute: pm }
          : { every: iEvery, unit: iUnit };

    setSubmitting(true);
    try {
      await onConfirm({
        title: title.trim(),
        prompt: prompt.trim(),
        workspace_id: workspaceId,
        model,
        agent_id: null,
        priority,
        scheduled_at:
          useSchedule && scheduledAt ? new Date(scheduledAt).toISOString() : null,
        depends_on: dependsOn,
        // 每行一个路径；空行忽略。真正的校验在后端（拒绝绝对路径/通配符/.git 等）
        scopes: scopesInput
          .split(/\r?\n/)
          .map(x => x.trim())
          .filter(Boolean),
        executor,
        // ⚠️ 不再传 isolation：服务端创建时一律写死 'shared'（worktree 已废弃），传了也没用
        repeat_mode,
        repeat_spec,
        repeat_until: useSchedule && untilAt ? new Date(untilAt).toISOString() : null,
        repeat_limit: useSchedule && limitCount.trim() ? Number(limitCount) : null,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const selectedWorkspace = workspaces.find(w => w.id === workspaceId);

  /** 定时段落的输入框共用样式（与既有视觉一致） */
  const schedInputStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.35)',
    border: '1px solid rgba(244,114,182,0.30)',
    color: '#fbcfe8',
    outline: 'none',
    colorScheme: 'dark',
  };
  /** 「执行方式」与「周几」的小胶囊按钮 */
  const schedChipStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'rgba(244,114,182,0.22)' : 'rgba(0,0,0,0.25)',
    border: `1px solid ${active ? 'rgba(244,114,182,0.65)' : 'rgba(244,114,182,0.20)'}`,
    color: active ? '#fbcfe8' : '#94a3b8',
    cursor: 'pointer',
  });
  const schedLabelStyle: React.CSSProperties = { color: '#94a3b8' };

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      header="新建任务"
      width={620}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button theme="primary" onClick={handleSubmit} loading={submitting}>
            创建任务
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 py-1">
        {/* 标题 */}
        <div>
          <label className="block text-xs mb-1.5 font-medium" style={{ color: '#94a3b8' }}>
            任务标题 <span style={{ color: '#f43f5e' }}>*</span>
          </label>
          <Input
            value={title}
            onChange={v => setTitle(String(v))}
            placeholder="例如：重构 sunshinerose 的订单导出模块"
            maxlength={120}
          />
        </div>

        {/* 任务描述 */}
        <div>
          <label className="block text-xs mb-1.5 font-medium" style={{ color: '#94a3b8' }}>
            任务指令 <span style={{ color: '#f43f5e' }}>*</span>
          </label>
          <Textarea
            value={prompt}
            onChange={v => setPrompt(String(v))}
            placeholder="描述需要 Agent 完成的具体工作。这段内容会作为 prompt 直接交给 SDK 执行。"
            autosize={{ minRows: 4, maxRows: 9 }}
          />
        </div>

        {/* 工作空间 + 模型 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              className="flex items-center gap-1.5 text-xs mb-1.5 font-medium"
              style={{ color: '#94a3b8' }}
            >
              <Puzzle size={12} />
              工作空间
            </label>
            <Select
              value={workspaceId ?? undefined}
              onChange={v => setWorkspaceId(v as string)}
              options={workspaceOptions}
              placeholder={workspaces.length === 0 ? '请先创建工作空间' : '选择工作空间'}
              disabled={workspaces.length === 0}
              filterable
            />
            {selectedWorkspace && (
              <div
                className="mt-1.5 text-[13px] font-mono truncate"
                style={{ color: '#64748b' }}
                title={selectedWorkspace.path}
              >
                并发上限 {selectedWorkspace.max_concurrency} · {selectedWorkspace.path}
              </div>
            )}
          </div>

          <div>
            <label
              className="flex items-center gap-1.5 text-xs mb-1.5 font-medium"
              style={{ color: '#94a3b8' }}
            >
              <Cpu size={12} />
              执行模型
            </label>
            <Select
              value={model}
              onChange={v => setModel(v as string)}
              options={modelOptions}
              placeholder="选择模型"
              filterable
            />
            {/* 说明清单来源 + 常用/全部切换 */}
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <span className="text-[12px] leading-snug" style={{ color: '#64748b' }}>
                显示 {visibleModels.length} / 共 {activeModels.length} 个
                {MODEL_SOURCE_HINT[activeSource] ? ` · ${MODEL_SOURCE_HINT[activeSource]}` : ''}
                {activeSource && activeSource !== 'workbuddy-config' && activeSource !== 'sdk'
                  ? '（与 WorkBuddy 可能不一致）'
                  : ''}
              </span>
              {activeModels.length > visibleModels.length && (
                <button
                  type="button"
                  className="text-[12px] underline underline-offset-2"
                  style={{ color: '#93c5fd' }}
                  onClick={() => setShowAllModels(true)}
                >
                  显示全部 {activeModels.length} 个
                </button>
              )}
              {showAllModels && (
                <button
                  type="button"
                  className="text-[12px] underline underline-offset-2"
                  style={{ color: '#93c5fd' }}
                  onClick={() => setShowAllModels(false)}
                >
                  只看常用
                </button>
              )}
            </div>
            {/* 本地执行器没模型可选时，把原因说清楚（而不是给一个空下拉） */}
            {activeModels.length === 0 && executor === 'local' && (
              <div className="text-[12px] mt-1 leading-snug" style={{ color: '#fca5a5' }}>
                本地执行器当前没有可用模型
                {executorModels?.reason ? `：${executorModels.reason}` : ''}
              </div>
            )}
          </div>
        </div>

        {/* 优先级 */}
        <div>
          <label className="flex items-center gap-1.5 text-xs mb-1.5 font-medium" style={{ color: '#94a3b8' }}>
            <Zap size={12} />
            优先级
            <span className="font-normal opacity-60">（同工作空间内高优先级先被调度）</span>
          </label>
          <div className="flex gap-2">
            {PRIORITY_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setPriority(opt.value)}
                className="flex-1 rounded-md py-1.5 text-xs font-medium transition-all"
                style={{
                  background:
                    priority === opt.value
                      ? `color-mix(in srgb, ${opt.color} 16%, transparent)`
                      : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${
                    priority === opt.value
                      ? opt.color
                      : 'var(--hairline)'
                  }`,
                  color: priority === opt.value ? opt.color : '#94a3b8',
                  boxShadow:
                    priority === opt.value ? `0 0 12px -4px ${opt.color}` : 'none',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 执行者：选项已移除 —— `workbuddy` 执行器下线后只剩本地一种，
            留一个"只有一个选项"的单选组只会增加理解成本（executor 恒为 local）。 */}

        {/* 执行隔离：整组已删除 —— `worktree` 不可用，且服务端把 isolation 写死为 'shared'，
            这组控件实际不生效（详见文件上方 ISOLATION_OPTIONS 位置留下的说明）。 */}

        {/* 定时执行 */}
        <div
          className="rounded-md p-3"
          style={{ background: 'rgba(244, 114, 182, 0.06)', border: '1px solid rgba(244,114,182,0.20)' }}
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={useSchedule}
              onChange={e => setUseSchedule(e.target.checked)}
              style={{ accentColor: '#f472b6', width: 14, height: 14, cursor: 'pointer' }}
            />
            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: '#f9a8d4' }}>
              <Clock size={12} />
              定时 / 定期循环（任务进入「自动化定时」板块，到点自动开始）
            </span>
          </label>

          {useSchedule && (
            <div className="mt-3 flex flex-col gap-3">
              {/* 执行方式：只执行一次 / 按周期 / 按间隔 */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11.5px] mr-0.5" style={schedLabelStyle}>
                  执行方式
                </span>
                {(
                  [
                    ['once', '只执行一次'],
                    ['periodic', '按周期'],
                    ['interval', '按间隔'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSchedKind(k)}
                    className="px-2.5 py-1 rounded text-[12px]"
                    style={schedChipStyle(schedKind === k)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* ---------- 只执行一次 ---------- */}
              {schedKind === 'once' && (
                <div>
                  <label className="block text-[11.5px] mb-1" style={schedLabelStyle}>
                    执行时间 <span style={{ color: '#f43f5e' }}>*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={e => setScheduledAt(e.target.value)}
                    className="w-full rounded px-2.5 py-1.5 text-xs font-mono"
                    style={schedInputStyle}
                  />
                </div>
              )}

              {/* ---------- 按周期：每天 / 每周 / 每月 固定时刻 ---------- */}
              {schedKind === 'periodic' && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11.5px]" style={schedLabelStyle}>
                      频率
                    </span>
                    <select
                      value={pFreq}
                      onChange={e => setPFreq(e.target.value as typeof pFreq)}
                      className="rounded px-2 py-1 text-xs"
                      style={schedInputStyle}
                    >
                      <option value="daily">每天</option>
                      <option value="weekly">每周</option>
                      <option value="monthly">每月</option>
                    </select>
                    <span className="text-[11.5px]" style={schedLabelStyle}>
                      时刻
                    </span>
                    <input
                      type="time"
                      value={pTime}
                      onChange={e => setPTime(e.target.value)}
                      className="rounded px-2 py-1 text-xs font-mono"
                      style={schedInputStyle}
                    />
                  </div>

                  {pFreq === 'weekly' && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11.5px]" style={schedLabelStyle}>
                        周几
                      </span>
                      {[
                        [1, '一'],
                        [2, '二'],
                        [3, '三'],
                        [4, '四'],
                        [5, '五'],
                        [6, '六'],
                        [0, '日'],
                      ].map(([value, label]) => {
                        const active = pDays.includes(value as number);
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() =>
                              setPDays(prev =>
                                prev.includes(value as number)
                                  ? prev.filter(x => x !== value)
                                  : [...prev, value as number]
                              )
                            }
                            className="px-2 py-1 rounded text-[12px]"
                            style={schedChipStyle(active)}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {pFreq === 'monthly' && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11.5px]" style={schedLabelStyle}>
                        日期
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={pDom}
                        onChange={e => setPDom(Number(e.target.value) || 1)}
                        className="w-16 rounded px-2 py-1 text-xs font-mono"
                        style={schedInputStyle}
                      />
                      <span className="text-[11.5px]" style={schedLabelStyle}>
                        日
                      </span>
                      <span className="text-[11px] opacity-60" style={{ color: '#94a3b8' }}>
                        （该月没有这一天时自动跳过，例如 31 日在 2 月）
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* ---------- 按间隔：每 N 分钟/小时/天 ---------- */}
              {schedKind === 'interval' && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11.5px]" style={schedLabelStyle}>
                    每
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={iEvery}
                    onChange={e => setIEvery(Number(e.target.value) || 1)}
                    className="w-16 rounded px-2 py-1 text-xs font-mono"
                    style={schedInputStyle}
                  />
                  <select
                    value={iUnit}
                    onChange={e => setIUnit(e.target.value as typeof iUnit)}
                    className="rounded px-2 py-1 text-xs"
                    style={schedInputStyle}
                  >
                    <option value="minute">分钟</option>
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                  </select>
                  <span className="text-[11px] opacity-60" style={{ color: '#94a3b8' }}>
                    （从每轮执行结束时刻起算）
                  </span>
                </div>
              )}

              {/* ---------- 周期/间隔的公共项：首次执行 + 有效期 + 次数上限 ---------- */}
              {schedKind !== 'once' && (
                <>
                  <div>
                    <label className="block text-[11.5px] mb-1" style={schedLabelStyle}>
                      首次执行（可选）
                    </label>
                    <input
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={e => setScheduledAt(e.target.value)}
                      className="w-full rounded px-2.5 py-1.5 text-xs font-mono"
                      style={schedInputStyle}
                    />
                    <div className="text-[11px] mt-1 opacity-70" style={{ color: '#94a3b8' }}>
                      留空则按上面的规则，从当前时间往后算第一次（推荐留空）
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11.5px] mb-1" style={schedLabelStyle}>
                        有效期至（可选）
                      </label>
                      <input
                        type="datetime-local"
                        value={untilAt}
                        onChange={e => setUntilAt(e.target.value)}
                        className="w-full rounded px-2.5 py-1.5 text-xs font-mono"
                        style={schedInputStyle}
                      />
                    </div>
                    <div>
                      <label className="block text-[11.5px] mb-1" style={schedLabelStyle}>
                        最多执行次数（可选）
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={limitCount}
                        onChange={e => setLimitCount(e.target.value)}
                        placeholder="留空 = 不限"
                        className="w-full rounded px-2.5 py-1.5 text-xs font-mono"
                        style={schedInputStyle}
                      />
                    </div>
                  </div>

                  <div className="text-[11px] leading-relaxed" style={{ color: '#94a3b8' }}>
                    循环任务每跑完一轮会自动排下一轮，明细保留在「执行历史」里；
                    想停下来用任务详情里的「暂停循环」（配置不丢，可随时恢复）。
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* 前置依赖 */}
        <div>
          <label
            className="flex items-center gap-1.5 text-xs mb-1.5 font-medium"
            style={{ color: '#94a3b8' }}
          >
            <GitBranch size={12} />
            前置依赖
            <span className="font-normal opacity-60">（所选任务全部完成后，本任务才可启动）</span>
          </label>
          {dependencyOptions.length === 0 ? (
            <div className="text-[13.5px] font-mono opacity-50 py-1">// 暂无可作为依赖的任务</div>
          ) : (
            <Select
              value={dependsOn}
              onChange={v => setDependsOn((v as string[]) || [])}
              options={dependencyOptions}
              multiple
              filterable
              placeholder="选择前置任务（可多选）"
              max={5}
            />
          )}
        </div>

        {/* 修改范围：声明式冲突治理 */}
        <div>
          <label
            className="flex items-center gap-1.5 text-xs mb-1.5 font-medium"
            style={{ color: '#94a3b8' }}
          >
            <Files size={12} />
            修改范围
            <span className="font-normal opacity-60">
              （每行一个仓库内路径；与运行中任务范围重叠时会排队）
            </span>
          </label>
          <Textarea
            value={scopesInput}
            onChange={v => setScopesInput(String(v))}
            placeholder={'留空表示不声明。例如：\nsrc/components\nserver/scheduler.ts'}
            autosize={{ minRows: 2, maxRows: 5 }}
          />
          <div className="text-[12.5px] mt-1" style={{ color: '#64748b' }}>
            不支持通配符与绝对路径；去掉最后一行会自动修正。
          </div>
        </div>
      </div>
    </Dialog>
  );
};

export default NewTaskDialog;
