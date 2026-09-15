/**
 * CodeBuddy 登录 / 绑定（Credential Binding）
 * ============================================================================
 * 背景（2026-09-14 用户反馈的两个问题）：
 *
 *  1. **进入「设置」页会自动弹出 CodeBuddy 登录页**
 *     根因：`GET /api/check-login` 直接调用了 `unstable_v2_authenticate()`。
 *     该 API 的语义是「**发起登录流程**」而不是「查询已登录状态」：
 *     命中已有凭据时它立即返回账号；否则 CLI 子进程会**自行打开浏览器**
 *     （源码链路：CLI `AuthenticationManager.openAuthUrl()` →
 *     `ExternalUriOpener.open()` → `UrlUtils.openUrl()` → win32 下
 *     `rundll32 url,OpenURL <url>`），然后一直等用户完成或超时。
 *     于是「打开设置页」这个只读动作，产生了「弹浏览器」的副作用。
 *
 *  2. **打开的是国际站 www.codebuddy.ai**
 *     根因：调用时硬编码 `environment: 'external'`。而本机实际凭据是
 *     **国内站**（`auth.domain = www.workbuddy.cn`）—— 站点不匹配 →
 *     被判定为「未登录」→ 每次都去弹国际站登录页。
 *
 * 本模块的契约（请勿破坏）：
 *  - `checkPassive()` —— **纯读本地文件**，绝不发起登录、绝不打开浏览器。
 *  - `startLogin()`   —— **只在用户明确点击按钮后**调用，按所选站点发起。
 *
 * 站点（environment）与域名的对应关系，来自 CLI 自带 product.json（已核实）：
 *   internal → 国内站    copilot.tencent.com / www.codebuddy.cn / www.workbuddy.cn / staging-*
 *   external → 国际站    www.codebuddy.ai / staging-codebuddy.tencent.com
 *   ioa      → 企业内网  tencent.sso.copilot.tencent.com / tencent.sso.codebuddy.cn / …
 *
 * 凭据真源（重要）：
 *   `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authId>.info`
 *   —— CLI 登录后写入的 JSON，含 `auth.domain` / `auth.accessToken` /
 *   `account.nickname` 等；`<authId>.info.logged-out` 是登出标记文件。
 *   本模块**只读**，且**只取非敏感字段**（昵称 / uid / domain / 过期时间），
 *   token 一律不出本模块。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { unstable_v2_authenticate } from '@tencent-ai/agent-sdk';
import { NODE_EXE } from './runtime.js';
// 路径脱敏（审计 M4）—— 凭据文件路径要保留"是哪个文件"，但不必带上目录结构
import { redactLocalPaths } from './redact.js';

// ============= 站点定义（唯一真源） =============

export type AuthEnvironmentChoice = 'internal' | 'external' | 'ioa';

export interface AuthEnvironmentMeta {
  value: AuthEnvironmentChoice;
  label: string;
  /** 该站点域名（用于界面提示与凭据域名反查） */
  domains: string[];
  note: string;
}

export const AUTH_ENVIRONMENTS: AuthEnvironmentMeta[] = [
  {
    value: 'internal',
    label: '国内站（推荐）',
    domains: [
      'copilot.tencent.com',
      'staging-copilot.tencent.com',
      'www.codebuddy.cn',
      'staging.codebuddy.cn',
      'www.workbuddy.cn',
      'staging.workbuddy.cn',
    ],
    note: '中国大陆可直连，与 WorkBuddy 桌面端同一账号体系',
  },
  {
    value: 'external',
    label: '国际站',
    domains: ['www.codebuddy.ai', 'staging-codebuddy.tencent.com'],
    note: '海外站点，中国大陆访问可能不稳定',
  },
  {
    value: 'ioa',
    label: '企业内网（iOA）',
    domains: [
      'tencent.sso.copilot.tencent.com',
      'tencent.sso.copilot-staging.tencent.com',
      'tencent.sso.codebuddy.cn',
      'tencent.staging-sso.codebuddy.cn',
    ],
    note: '仅腾讯内网 / iOA 环境可用',
  },
];

const VALID_ENVIRONMENTS = new Set<string>(AUTH_ENVIRONMENTS.map(e => e.value));

export function isValidEnvironment(v: unknown): v is AuthEnvironmentChoice {
  return typeof v === 'string' && VALID_ENVIRONMENTS.has(v);
}

export function environmentLabel(v: string | undefined): string {
  return AUTH_ENVIRONMENTS.find(e => e.value === v)?.label ?? String(v ?? '未知');
}

/** 由凭据里的域名反查站点；无法归类时返回 undefined（视为自建 / 未知站点） */
export function environmentOfDomain(domain: string | undefined): AuthEnvironmentChoice | undefined {
  if (!domain) return undefined;
  const host = domain.trim().toLowerCase();
  for (const env of AUTH_ENVIRONMENTS) {
    if (env.domains.some(d => d.toLowerCase() === host)) return env.value;
  }
  // 容错：带端口 / 带路径 / 通配写法
  for (const env of AUTH_ENVIRONMENTS) {
    if (env.domains.some(d => host.includes(d.toLowerCase()))) return env.value;
  }
  return undefined;
}

/**
 * 默认站点：**优先跟随已有凭据**，其次跟随宿主网络环境，最后兜底国内站。
 *
 * 之所以以凭据优先：站点与凭据是同一条记录（同一个 authId 文件），
 * 若默认值与已有凭据不一致，点一下按钮就会把用户现有的登录覆盖掉。
 */
export function defaultEnvironment(): AuthEnvironmentChoice {
  // ⚠️ 注意是 read?.credential?.domain —— readCliCredential() 返回的是
  // { exists, credential, readError } 这层包装（踩过一次：少写一层导致
  // 永远读不到已有凭据的站点，默认值静默退化成宿主网络环境）。
  const read = readCliCredential();
  const fromCredential = environmentOfDomain(read?.credential?.domain);
  if (fromCredential) return fromCredential;

  const raw = (process.env.CODEBUDDY_INTERNET_ENVIRONMENT || '').trim().toLowerCase();
  if (raw === 'external') return 'external';
  if (raw === 'ioa') return 'ioa';
  // internal 或 未设置 → 国内站
  return 'internal';
}

// ============= 路径解析 =============

/** 宿主根目录（与 hostAdapter 保持一致：CODEBUDDY_CONFIG_DIR → ~/.workbuddy） */
function resolveHostDir(): string {
  const fromEnv = process.env.CODEBUDDY_CONFIG_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.join(os.homedir(), '.workbuddy');
}

const HOST_DIR = resolveHostDir();

/** 宿主写入的账号快照（只读；用于展示「宿主桌面端已登录的账号」） */
const HOST_ACCOUNT_SNAPSHOT = path.join(
  HOST_DIR,
  'storage',
  'skeleton',
  'account-snapshot.json'
);

/** CLI 凭据目录：%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth */
function resolveAuthStoreDir(): string | undefined {
  const override = process.env.CODEBUDDY_AUTH_STORE_DIR;
  if (override) return override;
  // LOCALAPPDATA 缺失时（部分非 Explorer 启动方式）兜底到 ~/AppData/Local
  const localAppData =
    process.env.LOCALAPPDATA ||
    process.env.LocalAppData ||
    (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local') : undefined);
  if (!localAppData) return undefined;
  return path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

const AUTH_STORE_DIR = resolveAuthStoreDir();
/** 凭据文件名前缀 = product.json 的 authentication.id（本机为 workbuddy-desktop） */
const AUTH_ID = process.env.CODEBUDDY_AUTH_ID || 'workbuddy-desktop';

// ============= CLI 凭据读取（被动） =============

export interface CliCredentialView {
  /** 凭据文件路径（便于排障展示） */
  file: string;
  nickname?: string;
  uid?: string;
  type?: string;
  /** 登录站点域名，如 www.workbuddy.cn */
  domain?: string;
  environment?: AuthEnvironmentChoice;
  /** 过期时间（毫秒）；已过期则 isExpired = true */
  expiresAt?: number;
  isExpired?: boolean;
  /** 最近一次刷新时间，可当作「最近登录时间」展示 */
  lastRefreshTime?: number;
}

interface RawCredential {
  account?: { nickname?: string; uid?: string; type?: string };
  auth?: { domain?: string; accessToken?: string; expiresAt?: number; lastRefreshTime?: number };
}

/** 凭据文件读取结果（区分「读不到」与「没登录」，避免把权限问题误报成未登录） */
interface CredentialReadResult {
  credential?: CliCredentialView;
  /** 找到凭据文件但读取失败（例如被沙箱拦截）——不要据此判定「未登录」 */
  readError?: string;
  /** 凭据文件是否存在 */
  exists: boolean;
}

function readCliCredential(): CredentialReadResult | undefined {
  if (!AUTH_STORE_DIR) return undefined;
  const file = path.join(AUTH_STORE_DIR, `${AUTH_ID}.info`);
  const loggedOutMarker = `${file}.logged-out`;

  // ⚠️ 必须用 statSync 而不是 existsSync：existsSync 在**权限被拒**时也返回 false，
  // 会把「读不到」误报成「没登录」。这里把两者区分开，让界面给出可诊断的提示。
  try {
    fs.statSync(file);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { exists: false };
    return {
      exists: true,
      readError: `无法读取凭据文件（${err?.code ?? ''} ${err?.message ?? err}）`,
    };
  }

  // 登出标记：CLI 登出后留此文件（内容通常为空）
  try {
    if (fs.existsSync(loggedOutMarker)) {
      return { exists: true, readError: '凭据已被登出（存在 .logged-out 标记）' };
    }
  } catch {
    // 标记文件读取失败不影响主流程
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawCredential;
    if (!raw?.auth?.accessToken) {
      return { exists: true, readError: '凭据文件缺少 accessToken' };
    }
    const expiresAt = typeof raw.auth.expiresAt === 'number' ? raw.auth.expiresAt : undefined;
    return {
      exists: true,
      credential: {
        file,
        nickname: raw.account?.nickname,
        uid: raw.account?.uid,
        type: raw.account?.type,
        domain: raw.auth.domain,
        environment: environmentOfDomain(raw.auth.domain),
        expiresAt,
        isExpired: expiresAt ? expiresAt < Date.now() : undefined,
        lastRefreshTime:
          typeof raw.auth.lastRefreshTime === 'number' ? raw.auth.lastRefreshTime : undefined,
      },
    };
  } catch (err: any) {
    return { exists: true, readError: err?.message ?? String(err) };
  }
}

function readHostAccount(): { nickname: string; type?: string; editionType?: string; savedAt?: number } | undefined {
  try {
    if (!fs.existsSync(HOST_ACCOUNT_SNAPSHOT)) return undefined;
    const raw = JSON.parse(fs.readFileSync(HOST_ACCOUNT_SNAPSHOT, 'utf8'));
    const primary = raw?.primary;
    if (!primary || typeof primary !== 'object') return undefined;
    return {
      nickname: String(primary.nickname ?? ''),
      type: primary.type ? String(primary.type) : undefined,
      editionType: primary.editionType ? String(primary.editionType) : undefined,
      savedAt: typeof primary.savedAt === 'number' ? primary.savedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

// ============= 被动状态 =============

export interface EnvVarsView {
  apiKey?: string;
  authToken?: string;
  internetEnv?: string;
  baseUrl?: string;
}

export interface PassiveLoginStatus {
  /** 是否具备可用凭据（环境变量 或 CLI 凭据） */
  isLoggedIn: boolean;
  method?: 'env' | 'cli' | 'none';
  envConfigured: boolean;
  cliConfigured: boolean;
  envVars: EnvVarsView;
  /** 脱敏后的 API Key（沿用旧字段，前端直接展示） */
  apiKey?: string;
  /** CLI 已保存的凭据（真源：CLI 的 auth 目录） */
  cliCredential?: CliCredentialView;
  /** 凭据读取异常（例如被沙箱拦截）——此时「未登录」不可信 */
  cliCredentialError?: string;
  /** 宿主桌面端账号快照，仅作展示 */
  hostAccount?: { nickname: string; type?: string; editionType?: string; savedAt?: number };
  /** 进行中的登录尝试（若存在） */
  pending?: LoginAttemptView;
  /** 面向用户的说明文案 */
  note?: string;
  /** 可选站点清单（前端据此渲染选项，避免文案在两处重复） */
  environments: AuthEnvironmentMeta[];
  /** 推荐默认站点 */
  defaultEnvironment: AuthEnvironmentChoice;
}

function mask(secret: string): string {
  if (secret.length <= 12) return '****';
  return `${secret.slice(0, 8)}****${secret.slice(-4)}`;
}

function collectEnvVars(): EnvVarsView {
  const view: EnvVarsView = {};
  const { CODEBUDDY_API_KEY, CODEBUDDY_AUTH_TOKEN, CODEBUDDY_INTERNET_ENVIRONMENT, CODEBUDDY_BASE_URL } = process.env;
  if (CODEBUDDY_API_KEY) view.apiKey = mask(CODEBUDDY_API_KEY);
  if (CODEBUDDY_AUTH_TOKEN) view.authToken = mask(CODEBUDDY_AUTH_TOKEN);
  if (CODEBUDDY_INTERNET_ENVIRONMENT) view.internetEnv = CODEBUDDY_INTERNET_ENVIRONMENT;
  if (CODEBUDDY_BASE_URL) view.baseUrl = CODEBUDDY_BASE_URL;
  return view;
}

/**
 * 被动检查登录状态。
 *
 * ⚠️ 只读三类本地信息：进程环境变量、CLI 凭据文件、宿主账号快照。
 * **不会**调用 `unstable_v2_authenticate`，因此不可能弹出浏览器。
 */
export function checkPassive(): PassiveLoginStatus {
  const envVars = collectEnvVars();
  const envConfigured = Boolean(envVars.apiKey || envVars.authToken);

  const read = readCliCredential();
  const credential = read?.credential;
  const cliConfigured = Boolean(credential && !credential.isExpired);
  const hostAccount = readHostAccount();

  const status: PassiveLoginStatus = {
    isLoggedIn: envConfigured || cliConfigured,
    envConfigured,
    cliConfigured,
    envVars,
    apiKey: envVars.apiKey,
    /**
     * 🔴 2026-09-16（审计 M4）：`file` 是**绝对路径**，会带上用户名与目录结构。
     *    它的设计目的是"便于排障展示"，所以**保留文件名、收敛掉目录**：
     *    `C:\Users\<名字>\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
     *    → `…\workbuddy-desktop.info` —— 仍能辨认是哪个文件，但不再泄露本机结构。
     */
    cliCredential: credential
      ? { ...credential, file: redactLocalPaths(credential.file) }
      : credential,
    cliCredentialError: read?.readError,
    hostAccount,
    pending: pendingView(),
    environments: AUTH_ENVIRONMENTS,
    defaultEnvironment: defaultEnvironment(),
  };

  if (envConfigured) {
    status.method = 'env';
  } else if (cliConfigured) {
    status.method = 'cli';
  } else {
    status.method = 'none';
  }

  // 说明文案：把「为什么」讲清楚，避免用户看到「未绑定」却不知所以
  const notes: string[] = [];
  if (read && !read.exists) {
    notes.push('未找到 CodeBuddy CLI 凭据，可用环境变量，或点击下方按钮登录绑定。');
  }
  if (read?.readError) {
    notes.push(`CLI 凭据不可用：${read.readError}`);
  }
  if (credential) {
    const site = environmentLabel(credential.environment);
    if (credential.isExpired) {
      notes.push(`CLI 凭据已过期（${site}），请重新登录。`);
    } else if (!credential.environment) {
      notes.push(`CLI 已登录（站点：${credential.domain ?? '未知'}，非预置站点）。`);
    } else if (credential.environment !== status.defaultEnvironment) {
      notes.push(
        `CLI 凭据所在站点为「${site}」，与推荐站点「${environmentLabel(status.defaultEnvironment)}」不同。` +
          '切换站点会覆盖当前凭据，请谨慎操作。'
      );
    }
  }
  if (!cliConfigured && hostAccount?.nickname) {
    notes.push(`检测到宿主桌面端账号「${hostAccount.nickname}」，但 CLI 尚未确认可用凭据。`);
  }
  if (notes.length) status.note = notes.join(' ');

  return status;
}

// ============= 主动登录（仅在用户点击后） =============

export interface LoginAttemptView {
  phase: 'idle' | 'pending' | 'success' | 'error' | 'cancelled';
  environment?: AuthEnvironmentChoice;
  /** CLI 生成的登录地址；由本端回传给界面，供浏览器未自动打开时手动访问 */
  authUrl?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** 成功后回填的账号信息（非敏感） */
  user?: { nickname?: string; userName?: string; enterprise?: string };
}

interface PendingAttempt extends LoginAttemptView {
  /** 递增 id：用户取消 / 重新发起后，旧 Promise 的结果不得覆盖新状态 */
  id: number;
  cancelled: boolean;
}

let pending: PendingAttempt | undefined;
let attemptSeq = 0;

function pendingView(): LoginAttemptView | undefined {
  if (!pending || pending.phase === 'idle') return undefined;
  const { id: _id, cancelled: _cancelled, ...view } = pending;
  return view;
}

/** 读取当前（或最近一次）登录尝试的状态 */
export function getLoginState(): LoginAttemptView {
  return pendingView() ?? { phase: 'idle' };
}

/** 发起登录后等待用户完成的最长时间（毫秒） */
const LOGIN_TIMEOUT_MS = Number(process.env.AUTH_LOGIN_TIMEOUT_MS) || 3 * 60 * 1000;

export interface StartLoginResult {
  ok: boolean;
  environment?: AuthEnvironmentChoice;
  /** 已有进行中的尝试时返回 true，不会重复弹浏览器 */
  alreadyPending?: boolean;
  attempt?: LoginAttemptView;
  error?: string;
}

/**
 * 发起登录（**仅由用户点击触发**）。
 *
 * - 若该站点已有可用凭据，`authenticate()` 会立即返回账号 —— **不会打开浏览器**；
 * - 否则 CLI 会打开所选站点的登录页，本函数把 CLI 给出的 `authUrl` 回传，
 *   界面展示为可点击链接（浏览器未自动打开时的兜底）。
 *
 * 立即返回，实际登录在后台进行；进度用 `getLoginState()` 轮询。
 */
export function startLogin(environment: unknown): StartLoginResult {
  if (!isValidEnvironment(environment)) {
    return { ok: false, error: `不支持的登录站点：${String(environment)}` };
  }
  if (pending && pending.phase === 'pending') {
    return { ok: true, environment: pending.environment, alreadyPending: true, attempt: pendingView() };
  }

  const id = ++attemptSeq;
  pending = { id, cancelled: false, phase: 'pending', environment, startedAt: Date.now() };

  const isCurrent = (): boolean => Boolean(pending && pending.id === id && !pending.cancelled);

  void unstable_v2_authenticate({
    environment,
    // 显式指定 node：本机系统 PATH 无 node，SDK 兜底的裸 `node` 会 ENOENT
    executable: NODE_EXE,
    timeout: LOGIN_TIMEOUT_MS,
    onAuthUrl: (authState) => {
      if (!isCurrent()) return;
      pending!.authUrl = authState?.authUrl;
      console.log(
        `[Auth] 已按用户选择发起「${environmentLabel(environment)}」登录，地址：${authState?.authUrl}`
      );
    },
  })
    .then(result => {
      if (!isCurrent()) return;
      const info = result?.userinfo;
      pending!.phase = 'success';
      pending!.finishedAt = Date.now();
      pending!.user = {
        nickname: info?.userNickname,
        userName: info?.userName,
        enterprise: info?.enterprise,
      };
      console.log(
        `[Auth] 绑定成功：${info?.userName ?? info?.userId ?? '(未知账号)'} @ ${environmentLabel(environment)}`
      );
    })
    .catch((err: any) => {
      if (!isCurrent()) return;
      pending!.phase = 'error';
      pending!.finishedAt = Date.now();
      pending!.error = err?.message || String(err);
      console.warn(`[Auth] 登录未完成：${pending!.error}`);
    });

  return { ok: true, environment, attempt: pendingView() };
}

/**
 * 放弃当前登录尝试（用户点「取消」）。
 * ⚠️ SDK 未暴露 abort 接口，CLI 子进程会在超时后自行退出；
 * 本函数只保证**结果不再回写界面**，并允许改选站点重新发起。
 */
export function cancelLogin(): { ok: boolean } {
  if (pending && pending.phase === 'pending') {
    pending.cancelled = true;
    pending.phase = 'cancelled';
    pending.finishedAt = Date.now();
    console.log('[Auth] 用户取消了登录尝试');
  }
  return { ok: true };
}
