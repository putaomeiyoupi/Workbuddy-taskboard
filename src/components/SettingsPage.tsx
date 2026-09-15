import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Form, 
  Input, 
  Textarea, 
  Button, 
  Tooltip,
  Popconfirm,
  MessagePlugin,
  Loading,
  Link,
  Tag,
  Select
} from 'tdesign-react';
import { 
  AddIcon, 
  EditIcon, 
  DeleteIcon,
  CheckIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  RefreshIcon
} from 'tdesign-icons-react';
import { Bot, Sparkles, Code, FileText, Globe, Lightbulb } from 'lucide-react';
import { CustomAgent, PermissionMode } from '../types';

interface SettingsPageProps {
  agents: CustomAgent[];
  onAdd: (agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => CustomAgent;
  onUpdate: (id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>) => void;
  onDelete: (id: string) => void;
}

type LoginMethod = 'env' | 'cli' | 'none';
type AuthEnvValue = 'internal' | 'external' | 'ioa';

/** 可选的登录站点（由后端下发，避免文案在两处重复维护） */
interface AuthEnvironmentMeta {
  value: AuthEnvValue;
  label: string;
  /** 该站点域名清单（后端 AUTH_ENVIRONMENTS.domains） */
  domains: string[];
  note: string;
}

/** 一次登录尝试的进度（对应 GET /api/login/status） */
interface LoginAttempt {
  phase: 'idle' | 'pending' | 'success' | 'error' | 'cancelled';
  environment?: AuthEnvValue;
  authUrl?: string;
  error?: string;
  user?: { nickname?: string; userName?: string; enterprise?: string };
}

/** CLI 已保存的凭据（后端只读 CLI auth 目录，不含任何 token） */
interface CliCredential {
  file: string;
  nickname?: string;
  uid?: string;
  type?: string;
  domain?: string;
  environment?: AuthEnvValue;
  expiresAt?: number;
  isExpired?: boolean;
  lastRefreshTime?: number;
}

/**
 * 单个环境变量的「当前状态」（来自 `GET /api/env-config`）。
 *
 * ⚠️ `display` 对敏感项（API Key / Auth Token）是**脱敏后的**值，
 * 表单回填时**不能**把它当真值提交 —— 后端会把形如 `xx****yy` 的值
 * 识别为「未修改」并原样保留（见 `server/envConfig.ts` 的 MASK_DETECT）。
 */
interface EnvVarState {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  input: 'text' | 'password' | 'select';
  options?: Array<{ label: string; value: string }>;
  hint: string;
  pitfall?: string;
  credentialGroup?: 'api-key' | 'auth-token';
  /** `.env`（或进程环境）里是否已有有效值 */
  configured: boolean;
  /** 值来源：文件有效行 / 文件里被注释掉的默认值 / 仅进程环境 / 无 */
  source: 'file' | 'file-commented' | 'process' | 'none';
  /** 展示值：敏感项已脱敏，非敏感项明文 */
  display: string;
  /** 当前进程是否真的持有该变量 */
  activeInProcess: boolean;
  /** 文件里的值与进程里的值不一致（多半是改了 .env 没重启） */
  drift: boolean;
}

/** 最终生效的凭据（来自 `GET /api/env-config` 的 `effective`） */
interface EffectiveCredential {
  source: 'api-key' | 'auth-token' | 'cli-file' | 'none';
  label: string;
  reason: string;
  /** 已配置但当前**不会生效**的凭据来源 */
  shadowed: Array<{ source: 'api-key' | 'auth-token' | 'cli-file'; label: string }>;
  /** CLI 凭据剩余有效期（毫秒）；CLI 凭据已过期或无凭据时不存在 */
  cliExpiresInMs?: number;
  cliExpiresAt?: number;
  cliExpired: boolean;
}

/** `GET /api/env-config` 的整体状态 */
interface EnvFileState {
  filePath: string;
  exists: boolean;
  size: number;
  exampleExists: boolean;
  vars: EnvVarState[];
  missingRequired: string[];
  ready: boolean;
  fileReadable: boolean;
  readError?: string;
  verdict: string;
  effective: EffectiveCredential;
}

/**
 * 把毫秒剩余时长渲染成人类可读文案（倒计时用）。
 *
 * 粒度刻意分档：>2 天只报天，<2 天报「天+小时」，<1 小时报「分+秒」——
 * 既能一眼看出"还早/临近"，又不会在"还有 20 天"时每秒抖动。
 */
function formatRemaining(ms: number): string {
  if (ms <= 0) return '已过期';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (days >= 2) return `${days} 天 ${hours} 小时`;
  if (days >= 1) return `${days} 天 ${hours} 小时 ${mins} 分`;
  if (hours >= 1) return `${hours} 小时 ${mins} 分`;
  if (mins >= 1) return `${mins} 分 ${secs} 秒`;
  return `${secs} 秒`;
}

/**
 * CLI 凭据的「剩余有效期」实时倒计时。
 *
 * 只在剩余不足 2 天时才启用秒级节拍（临近过期才有必要读秒），
 * 否则 30 秒一次 —— 避免让一个"还有 20 天"的数字每秒重渲染整个设置页。
 */
function useExpiryClock(expiresAt?: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return;
    const period = remaining < 2 * 86400_000 ? 1000 : 30_000;
    const timer = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return now;
}

interface LoginStatus {
  isLoggedIn: boolean;
  checking: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string;
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
  /** 宿主（WorkBuddy 桌面端）已登录的账号，仅作展示 */
  hostAccount?: {
    nickname: string;
    type?: string;
    editionType?: string;
    savedAt?: number;
  };
  /** CLI 已保存的凭据（真源：CLI 的 auth 目录） */
  cliCredential?: CliCredential;
  /** 凭据读取异常（例如被沙箱拦截）——此时「未绑定」不可信 */
  cliCredentialError?: string;
  environments?: AuthEnvironmentMeta[];
  defaultEnvironment?: AuthEnvValue;
  note?: string;
}

/**
 * 兜底站点清单（仅当后端未下发 environments 时使用，正常情况以后端为准）。
 * 域名来源：CLI 自带 product.json 的 internalDomain / externalDomain / iOADomain。
 */
const ENV_OPTIONS_FALLBACK: AuthEnvironmentMeta[] = [
  {
    value: 'internal',
    label: '国内站（推荐）',
    domains: ['copilot.tencent.com', 'www.codebuddy.cn', 'www.workbuddy.cn'],
    note: '中国大陆可直连',
  },
  {
    value: 'external',
    label: '国际站',
    domains: ['www.codebuddy.ai'],
    note: '海外站点，中国大陆访问可能不稳定',
  },
  {
    value: 'ioa',
    label: '企业内网（iOA）',
    domains: ['tencent.sso.copilot.tencent.com'],
    note: '仅腾讯内网 / iOA 环境可用',
  },
];

const PRESET_ICONS = [
  { name: 'Bot', icon: Bot },
  { name: 'Sparkles', icon: Sparkles },
  { name: 'Code', icon: Code },
  { name: 'FileText', icon: FileText },
  { name: 'Globe', icon: Globe },
  { name: 'Lightbulb', icon: Lightbulb },
];

const PRESET_COLORS = [
  '#0052d9', '#0594fa', '#00a870', '#ed7b2f', 
  '#e34d59', '#a25eb5', '#5c6bc0', '#26a69a'
];

const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'default', label: 'default', description: '默认模式，所有操作需确认' },
  { value: 'acceptEdits', label: 'acceptEdits', description: '自动批准文件编辑，Bash 仍需确认' },
  { value: 'plan', label: 'plan', description: '规划模式，仅允许读取操作' },
  { value: 'bypassPermissions', label: 'bypassPermissions', description: '跳过所有权限检查（谨慎使用）' },
];

const PRESET_TEMPLATES = [
  {
    name: '代码助手',
    description: '专注于编程和代码相关任务',
    systemPrompt: '你是一个专业的编程助手。你擅长编写、审查和解释代码。请提供清晰、高效且符合最佳实践的代码解决方案。在解释时，请考虑代码的可读性、性能和可维护性。',
    icon: 'Code',
    color: '#0594fa',
  },
  {
    name: '写作助手',
    description: '帮助撰写和优化各类文档',
    systemPrompt: '你是一个专业的写作助手。你擅长撰写、编辑和优化各类文档，包括文章、报告、邮件等。请帮助用户提升文字表达的清晰度、逻辑性和吸引力。',
    icon: 'FileText',
    color: '#00a870',
  },
  {
    name: '翻译助手',
    description: '提供高质量的多语言翻译',
    systemPrompt: '你是一个专业的翻译助手。你精通多种语言，能够提供准确、自然、符合语境的翻译。请在翻译时保持原文的语气和风格，同时确保目标语言的地道表达。',
    icon: 'Globe',
    color: '#ed7b2f',
  },
  {
    name: '创意助手',
    description: '激发灵感，提供创意建议',
    systemPrompt: '你是一个富有创意的助手。你善于头脑风暴、提供创新想法和独特视角。请帮助用户突破思维定式，探索新的可能性，激发创造力。',
    icon: 'Lightbulb',
    color: '#a25eb5',
  },
];

/**
 * 「当前生效的凭据」横幅。
 *
 * 为什么必须有它：`.env` 配了 API Key、CLI 又登录了时，逐项列表会打出**两个**绿勾，
 * 用户自然理解成"双保险"。实际上只有权重高的那一个在用，另一个纯属摆设 ——
 * 反过来，用 CLI 登录的人会疑惑"我还要不要再补个 API Key"。
 * ⇒ 把结论、依据、以及"谁被压制"一次讲清。
 */
function EffectiveCredentialBanner({
  effective,
  clockNow,
}: {
  effective: EffectiveCredential;
  clockNow: number;
}) {
  const none = effective.source === 'none';
  const isCli = effective.source === 'cli-file';

  // CLI 凭据存在时才显示有效期（无论它是否生效 —— 用户都需要知道它还剩多久）
  const hasCliExpiry = typeof effective.cliExpiresAt === 'number';
  const remainingMs = hasCliExpiry ? effective.cliExpiresAt! - clockNow : 0;
  const expired = effective.cliExpired || (hasCliExpiry && remainingMs <= 0);
  const expiringSoon = hasCliExpiry && !expired && remainingMs < 24 * 3600 * 1000;

  const accent = none
    ? { bg: 'var(--td-error-color-1)', fg: 'var(--td-error-color)', border: 'var(--td-error-color)' }
    : { bg: 'var(--td-success-color-1)', fg: 'var(--td-success-color)', border: 'var(--td-success-color)' };

  return (
    <div
      className="rounded p-3 text-xs space-y-2"
      style={{ backgroundColor: accent.bg, border: `1px solid ${accent.border}` }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span style={{ color: accent.fg, fontWeight: 500 }}>
          {none ? '当前无可用凭据' : '当前生效的凭据'}
        </span>
        {!none && (
          <Tag size="small" variant="light" theme={isCli ? 'warning' : 'success'}>
            {effective.label}
          </Tag>
        )}
      </div>

      <div style={{ color: 'var(--td-text-color-secondary)' }}>{effective.reason}</div>

      {/* 被压制但已配置的凭据 —— 显式说明"配了但不生效"，避免误判 */}
      {effective.shadowed.length > 0 && (
        <div style={{ color: 'var(--td-warning-color)' }}>
          ⚠️ 另有 {effective.shadowed.length} 项凭据已配置但**当前不生效**：
          {effective.shadowed.map(s => s.label).join('、')}
          （权重低于上面那项）。它们不算"备份"，不会自动接管。
        </div>
      )}

      {/* CLI 凭据剩余有效期 */}
      {hasCliExpiry && (
        <div style={{ color: expired || expiringSoon ? 'var(--td-warning-color)' : 'var(--td-text-color-placeholder)' }}>
          CLI 凭据：
          {expired ? (
            <span style={{ fontWeight: 500 }}>已过期（请重新登录，或改用 API Key）</span>
          ) : (
            <>
              剩余有效期 <span style={{ fontWeight: 500 }}>{formatRemaining(remainingMs)}</span>
              {expiringSoon ? ' —— 即将到期，若它是你唯一凭据请尽快处理' : ''}
            </>
          )}
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>
            {` · 到期时间 ${new Date(effective.cliExpiresAt!).toLocaleString('zh-CN', { hour12: false })}`}
          </span>
        </div>
      )}
      {!hasCliExpiry && !none && effective.source !== 'cli-file' && (
        <div style={{ color: 'var(--td-text-color-placeholder)' }}>
          CLI 凭据：未检测到（不影响使用 —— 上面的凭据已足够）
        </div>
      )}
    </div>
  );
}

export function SettingsPage({ 
  agents, 
  onAdd, 
  onUpdate, 
  onDelete 
}: SettingsPageProps) {
  const [editingAgent, setEditingAgent] = useState<CustomAgent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    systemPrompt: '',
    icon: 'Bot',
    color: '#0052d9',
    permissionMode: 'default' as PermissionMode,
  });
  
  // 登录状态
  const [loginStatus, setLoginStatus] = useState<LoginStatus>({
    isLoggedIn: false,
    checking: true,
  });
  
  // 环境变量配置
  const [showEnvConfig, setShowEnvConfig] = useState(false);
  /**
   * 表单草稿：**只放用户本次改动过的字段**。
   *
   * ⚠️ 不要用「空对象初值 + 打开时清空」的写法 —— 那正是用户反馈
   * 「点开全是空白」的原因。现在打开面板会先拉 `GET /api/env-config`，
   * 把当前状态渲染在每一项旁边；输入框的 value 优先取草稿，其次取状态里的展示值。
   */
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [envState, setEnvState] = useState<EnvFileState | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState<string | undefined>(undefined);
  const [savingEnv, setSavingEnv] = useState(false);
  /** CLI 凭据剩余有效期的实时时钟（仅当 CLI 凭据带过期时间时才会走秒级节拍） */
  const envClockNow = useExpiryClock(envState?.effective?.cliExpiresAt);

  // 登录站点：默认跟随宿主网络环境（后端下发），用户可自行改选
  const [loginEnv, setLoginEnv] = useState<AuthEnvValue>('internal');
  const envTouchedRef = useRef(false);
  // 当前登录尝试的进度
  const [loginAttempt, setLoginAttempt] = useState<LoginAttempt>({ phase: 'idle' });
  const [startingLogin, setStartingLogin] = useState(false);

  /**
   * 检查登录状态（被动）。
   * 后端 `/api/check-login` 只读本地信息，**不会发起登录、不会弹浏览器**；
   * 真正的登录必须由用户点按钮走 `startLogin()`。
   */
  const checkLoginStatus = useCallback(async () => {
    setLoginStatus(prev => ({ ...prev, checking: true, error: undefined }));
    
    try {
      const response = await fetch('/api/check-login');
      const data = await response.json();
      
      setLoginStatus({
        isLoggedIn: data.isLoggedIn,
        checking: false,
        method: data.method,
        envConfigured: data.envConfigured,
        cliConfigured: data.cliConfigured,
        error: data.error,
        apiKey: data.apiKey,
        envVars: data.envVars,
        hostAccount: data.hostAccount,
        cliCredential: data.cliCredential,
        cliCredentialError: data.cliCredentialError,
        environments: data.environments,
        defaultEnvironment: data.defaultEnvironment,
        note: data.note,
      });
      // 未与用户交互前，站点默认值跟随宿主网络环境
      if (!envTouchedRef.current && data.defaultEnvironment) {
        setLoginEnv(data.defaultEnvironment as AuthEnvValue);
      }
      if (data.pending && data.pending.phase !== 'idle') {
        setLoginAttempt(data.pending);
      }
    } catch (error: any) {
      setLoginStatus({
        isLoggedIn: false,
        checking: false,
        error: error?.message || '检查登录状态失败',
      });
    }
  }, []);

  /** 发起登录（仅用户点击时调用；会在浏览器打开所选站点的登录页） */
  const startLogin = async () => {
    setStartingLogin(true);
    try {
      const response = await fetch('/api/login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: loginEnv }),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        MessagePlugin.error(data.error || '发起登录失败');
        return;
      }
      setLoginAttempt(data.attempt ?? { phase: 'pending', environment: loginEnv });
      MessagePlugin.info('已发起登录，请在浏览器中完成；若未自动打开，可用下方链接');
    } catch (error: any) {
      MessagePlugin.error(error?.message || '发起登录失败');
    } finally {
      setStartingLogin(false);
    }
  };

  /** 放弃当前登录尝试 */
  const cancelLogin = async () => {
    try {
      await fetch('/api/login/cancel', { method: 'POST' });
    } catch {
      // 取消失败不阻塞界面
    }
    setLoginAttempt({ phase: 'idle' });
  };

  // 登录进行中：每 2 秒轮询一次进度
  useEffect(() => {
    if (loginAttempt.phase !== 'pending') return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch('/api/login/status');
        const data: LoginAttempt = await response.json();
        if (stopped) return;
        setLoginAttempt(data);
        if (data.phase === 'success') {
          MessagePlugin.success('绑定成功');
          checkLoginStatus();
        } else if (data.phase === 'error') {
          MessagePlugin.error(`登录未完成：${data.error || '未知原因'}`);
        }
      } catch {
        // 单次轮询失败忽略，下一轮继续
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [loginAttempt.phase, checkLoginStatus]);
  
  /**
   * 拉取环境变量配置状态。
   *
   * 打开「配置环境变量」面板时调用 —— 目的是让用户**看到当前配了什么**，
   * 而不是面对一张空表。同时暴露「必填项缺失 / 改了没重启」这类状态。
   */
  const loadEnvState = useCallback(async () => {
    setEnvLoading(true);
    setEnvError(undefined);
    try {
      const response = await fetch('/api/env-config');
      const data = await response.json();
      if (!response.ok) {
        setEnvError(data?.error || `读取失败（HTTP ${response.status}）`);
        return;
      }
      setEnvState(data as EnvFileState);
    } catch (error: any) {
      setEnvError(error?.message || '读取环境变量配置失败');
    } finally {
      setEnvLoading(false);
    }
  }, []);

  /** 打开 / 关闭「配置环境变量」面板（打开时拉一次状态，并清空草稿） */
  const toggleEnvConfig = useCallback(() => {
    setShowEnvConfig(prev => {
      const next = !prev;
      if (next) {
        setEnvDraft({});
        void loadEnvState();
      }
      return next;
    });
  }, [loadEnvState]);

  /**
   * 保存环境变量配置（写入项目根 `.env`）。
   *
   * ⚠️ 只提交**用户改动过**的字段（`envDraft`）—— 未改动的项不发，
   * 后端按「合并」语义保留原值。这样也天然避免了把脱敏占位符当值写回去。
   */
  const saveEnvConfig = async () => {
    const keys = Object.keys(envDraft);
    if (!keys.length) {
      MessagePlugin.warning('没有任何改动');
      return;
    }

    // 凭据至少要有一个（与后端一致的前置校验，避免白跑一次请求）
    const draftCredentialFilled =
      Boolean(envDraft.CODEBUDDY_API_KEY?.trim()) || Boolean(envDraft.CODEBUDDY_AUTH_TOKEN?.trim());
    const existingCredential =
      Boolean(envState?.vars.find(v => v.credentialGroup === 'api-key')?.configured) ||
      Boolean(envState?.vars.find(v => v.credentialGroup === 'auth-token')?.configured);
    const credentialBeingCleared =
      envDraft.CODEBUDDY_API_KEY === '' && envDraft.CODEBUDDY_AUTH_TOKEN === undefined;

    if (!draftCredentialFilled && !existingCredential) {
      MessagePlugin.warning('请至少填写 API Key 或 Auth Token 中的一项');
      return;
    }
    if (credentialBeingCleared && !envDraft.CODEBUDDY_AUTH_TOKEN?.trim()) {
      MessagePlugin.warning('清空后必须至少保留一项凭据（API Key 或 Auth Token）');
      return;
    }

    setSavingEnv(true);
    try {
      const response = await fetch('/api/env-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envDraft),
      });
      const data = await response.json();

      if (!response.ok || !data?.ok) {
        MessagePlugin.error(data?.error || '保存失败');
        return;
      }

      MessagePlugin.success(data.message || '已保存');
      // 保存后不回填草稿，直接把状态换成后端返回的最新快照
      setEnvDraft({});
      if (data.state) setEnvState(data.state as EnvFileState);
      // 进程内环境可能已变（虽然要重启才真正生效），顺带刷新登录状态
      checkLoginStatus();
    } catch (error: any) {
      MessagePlugin.error(error?.message || '保存失败');
    } finally {
      setSavingEnv(false);
    }
  };

  // 初始化时检查登录状态
  useEffect(() => {
    checkLoginStatus();
  }, [checkLoginStatus]);

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      systemPrompt: '',
      icon: 'Bot',
      color: '#0052d9',
      permissionMode: 'default',
    });
    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleEdit = (agent: CustomAgent) => {
    if (agent.id === 'default') return;
    setEditingAgent(agent);
    setFormData({
      name: agent.name,
      description: agent.description || '',
      systemPrompt: agent.systemPrompt,
      icon: agent.icon || 'Bot',
      color: agent.color || '#0052d9',
      permissionMode: agent.permissionMode || 'default',
    });
    setIsCreating(true);
  };

  const handleSave = () => {
    if (!formData.name.trim() || !formData.systemPrompt.trim()) {
      MessagePlugin.warning('请填写名称和系统提示词');
      return;
    }

    if (editingAgent) {
      onUpdate(editingAgent.id, formData);
      MessagePlugin.success('Agent 已更新');
    } else {
      onAdd(formData);
      MessagePlugin.success('Agent 已创建');
    }
    resetForm();
  };

  const handleUseTemplate = (template: typeof PRESET_TEMPLATES[0]) => {
    setFormData({
      ...template,
      description: template.description,
      permissionMode: 'default',
    });
    setIsCreating(true);
  };

  const handleDelete = (id: string) => {
    onDelete(id);
    MessagePlugin.success('Agent 已删除');
  };

  const getIconComponent = (iconName: string) => {
    const preset = PRESET_ICONS.find(p => p.name === iconName);
    return preset ? preset.icon : Bot;
  };

  const customAgents = agents.filter(a => a.id !== 'default');

  /** 站点名：优先用后端下发的文案，兜底本地映射 */
  const envLabelOf = (v?: AuthEnvValue): string => {
    const found = loginStatus.environments?.find(e => e.value === v);
    if (found) return found.label;
    if (v === 'internal') return '国内站';
    if (v === 'external') return '国际站';
    if (v === 'ioa') return '企业内网';
    return '';
  };

  const fmtTime = (ts?: number): string =>
    ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';

  /**
   * 被"压制"的凭据对应的环境变量名集合。
   *
   * 凭据来源（api-key / auth-token / cli-file）到变量名的映射只维护这一份，
   * 供逐项列表打「已配置但不生效」用。
   * ⚠️ `cli-file` 不在 `.env` 字段里（它有自己的展示区），故映射为空、不参与逐项标记。
   */
  const shadowedKeys = new Set<string>(
    (envState?.effective.shadowed ?? [])
      .map(s => (s.source === 'api-key' ? 'CODEBUDDY_API_KEY' : s.source === 'auth-token' ? 'CODEBUDDY_AUTH_TOKEN' : ''))
      .filter(Boolean)
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* 页面标题（返回按钮统一在顶栏 Header） */}
        <div>
          <h1 
            className="text-2xl font-semibold mb-2"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            设置
          </h1>
          <p style={{ color: 'var(--td-text-color-secondary)' }}>
            管理登录配置和自定义 Agent
          </p>
        </div>

        {/* 登录配置 */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 
                className="text-lg font-medium"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                登录配置
              </h2>
              <p 
                className="text-sm mt-1"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                支持环境变量或 CodeBuddy CLI 登录
              </p>
            </div>
            <Button 
              variant="text" 
              icon={<RefreshIcon />}
              onClick={checkLoginStatus}
              loading={loginStatus.checking}
            >
              刷新
            </Button>
          </div>
          
          {/* 当前状态 */}
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            {loginStatus.checking ? (
              <>
                <Loading size="small" />
                <span style={{ color: 'var(--td-text-color-secondary)' }}>
                  正在检查登录状态...
                </span>
              </>
            ) : loginStatus.isLoggedIn ? (
              <>
                <CheckCircleFilledIcon 
                  size="20px" 
                  style={{ color: 'var(--td-success-color)' }} 
                />
                <span style={{ color: 'var(--td-text-color-primary)' }}>
                  已登录
                </span>
                <Tag size="small" variant="outline">
                  {loginStatus.method === 'env'
                    ? '环境变量'
                    : `CLI · ${envLabelOf(loginStatus.cliCredential?.environment)}`}
                </Tag>
                {loginStatus.method === 'env' && loginStatus.apiKey && (
                  <span 
                    className="text-sm font-mono"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    {loginStatus.apiKey}
                  </span>
                )}
                {loginStatus.method === 'cli' && loginStatus.cliCredential && (
                  <span
                    className="text-sm"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    {loginStatus.cliCredential.nickname || ''}
                  </span>
                )}
              </>
            ) : (
              <>
                <CloseCircleFilledIcon 
                  size="20px" 
                  style={{ color: 'var(--td-text-color-placeholder)' }} 
                />
                <span style={{ color: 'var(--td-text-color-secondary)' }}>
                  未绑定
                </span>
              </>
            )}
          </div>

          {/* 状态补充说明：宿主账号 / 绑定时间 / 官方提示 */}
          <div
            className="text-xs mb-6 space-y-1"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            {loginStatus.cliCredential ? (
              <div>
                凭据站点：{loginStatus.cliCredential.domain || envLabelOf(loginStatus.cliCredential.environment)}
                {loginStatus.cliCredential.lastRefreshTime
                  ? ` · 最近登录：${fmtTime(loginStatus.cliCredential.lastRefreshTime)}`
                  : ''}
                {loginStatus.cliCredential.expiresAt
                  ? ` · 过期：${fmtTime(loginStatus.cliCredential.expiresAt)}`
                  : ''}
              </div>
            ) : null}
            {loginStatus.hostAccount?.nickname ? (
              <div>
                宿主账号：{loginStatus.hostAccount.nickname}
                {loginStatus.hostAccount.editionType
                  ? `（${loginStatus.hostAccount.editionType}）`
                  : ''}
              </div>
            ) : null}
            {loginStatus.note ? <div>{loginStatus.note}</div> : null}
          </div>
          
          {/* 环境变量配置 */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-1">
              <h3
                className="text-sm font-medium"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                方式一：环境变量（写入项目根 .env）
              </h3>
              {envState?.vars.some(v => v.configured) && (
                <Tag size="small" variant="light" theme="success">
                  已配置
                </Tag>
              )}
            </div>
            <p
              className="text-xs mb-3"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              保存后写入 <span className="font-mono">{envState?.filePath ?? '项目根/.env'}</span>
              ；⚠️ 环境变量在进程启动时读取，**保存后需重启看板才生效**。
            </p>

            {showEnvConfig ? (
              <div className="space-y-3">
                {/* 当前状态汇总：避免用户面对一张空表 */}
                {envLoading && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                    <Loading size="small" />
                    正在读取当前配置...
                  </div>
                )}
                {envError && (
                  <div className="text-xs" style={{ color: 'var(--td-error-color)' }}>
                    {envError}
                  </div>
                )}
                {envState && !envLoading && (
                  <div
                    className="rounded p-3 text-xs space-y-1"
                    style={{
                      backgroundColor: 'var(--td-bg-color-container-hover)',
                      color: 'var(--td-text-color-secondary)',
                    }}
                  >
                    <div>{envState.verdict}</div>
                    <div style={{ color: 'var(--td-text-color-placeholder)' }}>
                      文件：
                      {envState.exists
                        ? `已存在（${envState.size} 字节）`
                        : '尚未创建，保存后自动创建'}
                      {envState.missingRequired.length
                        ? ` · 必填未配：${envState.missingRequired.join('、')}`
                        : ''}
                    </div>
                  </div>
                )}

                {/* ⭐ 当前生效的凭据 —— 用户最容易困惑的点：多个都"已配置"，但只有一个真在用 */}
                {envState && !envLoading && (
                  <EffectiveCredentialBanner
                    effective={envState.effective}
                    clockNow={envClockNow}
                  />
                )}

                {/* 逐项渲染：必填角标 + 当前值来源 + 坑位说明 */}
                <div className="space-y-3">
                  {(envState?.vars ?? []).map(v => {
                    const draft = envDraft[v.key];
                    const value = draft !== undefined ? draft : v.display;
                    return (
                      <div key={v.key}>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <label
                            className="text-xs font-mono"
                            style={{ color: 'var(--td-text-color-placeholder)' }}
                          >
                            {v.key}
                          </label>
                          {v.required && (
                            <Tag size="small" variant="light" theme="danger">
                              必填
                            </Tag>
                          )}
                          {v.credentialGroup && (
                            <Tag size="small" variant="light" theme="warning">
                              凭据二选一
                            </Tag>
                          )}
                          {v.configured ? (
                            <span className="text-xs" style={{ color: 'var(--td-success-color)' }}>
                              ✓ 已配置
                              {v.source === 'process' ? '（来自进程环境，非 .env）' : ''}
                              {v.source === 'file-commented' ? '（.env 中为注释状态）' : ''}
                            </span>
                          ) : (
                            <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                              未配置
                            </span>
                          )}
                          {/* ⭐ 这一项虽已配置，但按权重判定当前不会生效 —— 必须点明，
                              否则逐项列表里的绿勾会让人误以为"这样就够了" */}
                          {v.configured && shadowedKeys.has(v.key) && (
                            <Tag size="small" variant="light" theme="warning">
                              已配置但不生效
                            </Tag>
                          )}
                          {v.configured && v.credentialGroup === envState?.effective.source && (
                            <Tag size="small" variant="light" theme="success">
                              当前生效
                            </Tag>
                          )}
                          {v.drift && (
                            <Tag size="small" variant="light" theme="warning">
                              改了未重启
                            </Tag>
                          )}
                        </div>

                        {v.input === 'select' ? (
                          <Select
                            size="small"
                            style={{ width: '100%' }}
                            value={value}
                            onChange={(val) =>
                              setEnvDraft(prev => ({ ...prev, [v.key]: (val as string) ?? '' }))
                            }
                            placeholder="请选择（国际站请留空）"
                            clearable
                            options={v.options ?? []}
                          />
                        ) : (
                          <Input
                            size="small"
                            type={v.secret ? 'password' : 'text'}
                            value={value}
                            onChange={(val) =>
                              setEnvDraft(prev => ({ ...prev, [v.key]: (val as string) ?? '' }))
                            }
                            placeholder={v.secret ? '留空则不修改；输入内容后覆盖' : '留空即不设置'}
                          />
                        )}

                        <div
                          className="text-xs mt-1"
                          style={{ color: 'var(--td-text-color-placeholder)' }}
                        >
                          {v.hint}
                        </div>
                        {v.pitfall && (
                          <div
                            className="text-xs mt-1"
                            style={{ color: 'var(--td-warning-color)' }}
                          >
                            {v.pitfall}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* 必填项缺失时的显式警告 —— 原界面完全没提「哪些必须配」 */}
                {envState && envState.missingRequired.length > 0 && (
                  <div
                    className="rounded p-2 text-xs"
                    style={{
                      backgroundColor: 'var(--td-error-color-1)',
                      color: 'var(--td-error-color)',
                    }}
                  >
                    ⚠️ 以下必填项尚未配置：
                    {envState.missingRequired.join('、')}。缺少站点设置会导致「鉴权失败或连到错误的服务端点」。
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="small"
                    theme="primary"
                    onClick={saveEnvConfig}
                    loading={savingEnv}
                    disabled={!Object.keys(envDraft).length}
                  >
                    保存到 .env
                  </Button>
                  <Button
                    size="small"
                    variant="outline"
                    onClick={() => void loadEnvState()}
                    loading={envLoading}
                  >
                    重新读取
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setShowEnvConfig(false);
                      setEnvDraft({});
                    }}
                  >
                    收起
                  </Button>
                  <span
                    className="text-xs"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    保存后需重启看板生效
                  </span>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="small"
                onClick={toggleEnvConfig}
              >
                配置环境变量
              </Button>
            )}
          </div>
          
          {/* CLI 登录（**仅用户主动点击才会打开浏览器**） */}
          <div>
            <h3
              className="text-sm font-medium mb-1"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              方式二：CodeBuddy CLI 登录
            </h3>
            <p
              className="text-xs mb-3"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              与「方式一」是**二选一**：方式一走 `.env` 里的静态凭证，方式二走 CLI 保存的登录凭据（
              {`%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth`}）。
              两者都可用时以环境变量为准（见上方「登录配置」的方法标签）。
              本页不会自动跳转登录页 —— 请先选择站点，再点击按钮，届时才会在浏览器打开所选站点的登录页。
            </p>

            {loginAttempt.phase === 'pending' ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <Loading size="small" />
                  <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>
                    等待浏览器完成登录（{envLabelOf(loginAttempt.environment)}）
                  </span>
                  <Button size="small" variant="text" onClick={cancelLogin}>
                    取消
                  </Button>
                </div>
                {loginAttempt.authUrl && (
                  <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    若浏览器未自动打开，请手动访问：
                    <Link
                      href={loginAttempt.authUrl}
                      target="_blank"
                      theme="primary"
                      size="small"
                    >
                      打开登录页
                    </Link>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <Select
                    size="small"
                    value={loginEnv}
                    style={{ width: 190 }}
                    onChange={(v) => {
                      envTouchedRef.current = true;
                      setLoginEnv(v as AuthEnvValue);
                    }}
                    options={(loginStatus.environments?.length
                      ? loginStatus.environments
                      : ENV_OPTIONS_FALLBACK
                    ).map(e => ({ label: e.label, value: e.value }))}
                  />
                  <Button
                    theme="primary"
                    size="small"
                    loading={startingLogin}
                    onClick={startLogin}
                  >
                    {loginStatus.cliConfigured ? '重新绑定 / 切换站点' : '登录 / 绑定'}
                  </Button>
                  <Link 
                    href="https://www.codebuddy.ai/docs/zh/cli/settings" 
                    target="_blank"
                    theme="primary"
                    size="small"
                  >
                    查看文档
                  </Link>
                </div>
                {(() => {
                  const list = loginStatus.environments?.length
                    ? loginStatus.environments
                    : ENV_OPTIONS_FALLBACK;
                  const cur = list.find(e => e.value === loginEnv);
                  if (!cur) return null;
                  return (
                    <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      登录站点：
                      {cur.domains?.length
                        ? `${cur.domains.slice(0, 2).join(' / ')}${cur.domains.length > 2 ? ' 等' : ''}`
                        : '—'}{' '}
                      —— {cur.note}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
          
          {loginStatus.error && !loginStatus.isLoggedIn && (
            <div 
              className="text-xs mt-4"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              {loginStatus.error}
            </div>
          )}
        </div>

        <div 
          style={{ 
            height: '1px', 
            backgroundColor: 'var(--td-component-border)' 
          }} 
        />

        {/* Agent 配置 */}
        <div>
          <div className="mb-4">
            <h2 
              className="text-lg font-medium"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              Agent 配置
            </h2>
            <p 
              className="text-sm mt-1"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              创建和管理自定义 Agent
            </p>
          </div>

          <div className="space-y-6">
              {/* 创建/编辑表单 */}
              {isCreating ? (
                <div 
                  className="p-5 rounded-xl border"
                  style={{ 
                    backgroundColor: 'var(--td-bg-color-container)',
                    borderColor: 'var(--td-component-border)'
                  }}
                >
                  <div className="space-y-4">
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-base font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                        {editingAgent ? '编辑 Agent' : '创建新 Agent'}
                      </h4>
                      <Button variant="text" onClick={resetForm}>取消</Button>
                    </div>
                    
                    <Form labelAlign="top">
                      <Form.FormItem label="名称" requiredMark>
                        <Input 
                          value={formData.name}
                          onChange={(v) => setFormData(prev => ({ ...prev, name: v as string }))}
                          placeholder="例如：代码助手"
                        />
                      </Form.FormItem>
                      
                      <Form.FormItem label="描述">
                        <Input 
                          value={formData.description}
                          onChange={(v) => setFormData(prev => ({ ...prev, description: v as string }))}
                          placeholder="简短描述这个 Agent 的用途"
                        />
                      </Form.FormItem>
                      
                      <Form.FormItem label="图标和颜色">
                        <div className="flex gap-4">
                          <div className="flex gap-2">
                            {PRESET_ICONS.map(({ name, icon: Icon }) => (
                              <button
                                key={name}
                                type="button"
                                className="w-9 h-9 rounded-lg flex items-center justify-center transition-all border-2"
                                style={{
                                  backgroundColor: formData.icon === name ? formData.color : 'transparent',
                                  color: formData.icon === name ? 'white' : 'var(--td-text-color-secondary)',
                                  borderColor: formData.icon === name ? formData.color : 'var(--td-component-border)',
                                }}
                                onClick={() => setFormData(prev => ({ ...prev, icon: name }))}
                              >
                                <Icon size={18} />
                              </button>
                            ))}
                          </div>
                          <div className="flex gap-1.5 items-center">
                            {PRESET_COLORS.map(color => (
                              <button
                                key={color}
                                type="button"
                                className="w-7 h-7 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                                style={{ backgroundColor: color }}
                                onClick={() => setFormData(prev => ({ ...prev, color }))}
                              >
                                {formData.color === color && <CheckIcon style={{ color: 'white' }} size="14px" />}
                              </button>
                            ))}
                          </div>
                        </div>
                      </Form.FormItem>
                      
                      <Form.FormItem label="权限模式">
                        <Select
                          value={formData.permissionMode}
                          onChange={(v) => setFormData(prev => ({ ...prev, permissionMode: v as PermissionMode }))}
                          style={{ width: '100%' }}
                        >
                          {PERMISSION_MODES.map(mode => (
                            <Select.Option key={mode.value} value={mode.value} label={mode.label}>
                              <div className="flex flex-col py-1">
                                <span className="font-mono text-sm" style={{ color: 'var(--td-success-color)' }}>
                                  {mode.label}
                                </span>
                                <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                                  {mode.description}
                                </span>
                              </div>
                            </Select.Option>
                          ))}
                        </Select>
                      </Form.FormItem>
                      
                      <Form.FormItem label="系统提示词" requiredMark>
                        <Textarea 
                          value={formData.systemPrompt}
                          onChange={(v) => setFormData(prev => ({ ...prev, systemPrompt: v as string }))}
                          placeholder="定义 Agent 的行为和能力..."
                          autosize={{ minRows: 4, maxRows: 8 }}
                        />
                      </Form.FormItem>
                    </Form>
                    
                    <div className="flex justify-end gap-2 pt-2">
                      <Button variant="outline" onClick={resetForm}>取消</Button>
                      <Button theme="primary" onClick={handleSave}>
                        {editingAgent ? '保存修改' : '创建 Agent'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* 快速模板 */}
                  <div>
                    <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                      快速创建
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      {PRESET_TEMPLATES.map(template => {
                        const Icon = getIconComponent(template.icon);
                        return (
                          <div 
                            key={template.name} 
                            className="p-3 rounded-lg cursor-pointer transition-all hover:shadow-md"
                            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
                            onClick={() => handleUseTemplate(template)}
                          >
                            <div className="flex items-center gap-3">
                              <div 
                                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                                style={{ backgroundColor: template.color }}
                              >
                                <Icon size={20} color="white" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate" style={{ color: 'var(--td-text-color-primary)' }}>
                                  {template.name}
                                </div>
                                <div className="text-xs truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                                  {template.description}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 自定义创建按钮 */}
                  <Button 
                    icon={<AddIcon />} 
                    variant="dashed" 
                    block 
                    onClick={() => setIsCreating(true)}
                  >
                    从头创建 Agent
                  </Button>

                  {/* 已有的自定义 Agent */}
                  {customAgents.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                        我的 Agent ({customAgents.length})
                      </h4>
                      <div className="space-y-2">
                        {customAgents.map(agent => {
                          const Icon = getIconComponent(agent.icon || 'Bot');
                          return (
                            <div 
                              key={agent.id} 
                              className="p-3 rounded-lg"
                              style={{ backgroundColor: 'var(--td-bg-color-component)' }}
                            >
                              <div className="flex items-center gap-3">
                                <div 
                                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                                  style={{ backgroundColor: agent.color || '#0052d9' }}
                                >
                                  <Icon size={20} color="white" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                                    {agent.name}
                                  </div>
                                  <div className="text-xs truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                                    {agent.description || agent.systemPrompt.slice(0, 50) + '...'}
                                  </div>
                                </div>
                                <div className="flex gap-1">
                                  <Tooltip content="编辑">
                                    <Button 
                                      variant="text" 
                                      shape="circle" 
                                      size="small"
                                      icon={<EditIcon />}
                                      onClick={() => handleEdit(agent)}
                                    />
                                  </Tooltip>
                                  <Popconfirm
                                    content="确定删除这个 Agent 吗？"
                                    onConfirm={() => handleDelete(agent.id)}
                                  >
                                    <Tooltip content="删除">
                                      <Button 
                                        variant="text" 
                                        shape="circle" 
                                        size="small"
                                        icon={<DeleteIcon />}
                                      />
                                    </Tooltip>
                                  </Popconfirm>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
        </div>
      </div>
    </div>
  );
}
