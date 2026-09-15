/**
 * `.env` 配置读写（设置页「配置环境变量」的唯一后端真源）
 * ============================================================================
 * 背景（2026-09-14 用户反馈）：
 *   点击设置页的「配置环境变量」后，表单**全是空白**，看不出当前配了什么、
 *   哪一项是必填、以及此前文档里反复强调的「坑」。
 *
 * 但真正的问题比"没显示"更严重 —— 原来的 `POST /api/save-env-config`
 * **只写 `process.env`（内存）**：
 *   - 重启即丢；
 *   - 与 `server/loadEnv.ts`（读项目根 `.env`）**完全是两条路**，
 *     用户以为"保存了就有"，实际下次启动又回到 .env 的旧值。
 *
 * 本模块把「配置」真正落到**项目根 `.env` 文件**，并提供：
 *   - `readEnvFile()`   —— 读当前状态（脱敏后的凭证 + 明文站点/端点）
 *   - `writeEnvFile()`  —— 按字段增量更新（保留注释，只改目标键）
 *   - `describeEnvState()` —— 给界面用的「已配置 / 缺失 / 必填」判定
 *
 * 契约（勿破坏）：
 *   1. **绝不返回完整密钥**。凭证一律脱敏（`mask()`），只回明文给「站点/端点」这类非敏感项。
 *   2. **`.env` 永不提交**（已在 `.gitignore`）。本模块只写项目根，不写宿主目录。
 *   3. 写入采用「**保留原注释、只替换目标键行**」策略，不用模板整体覆盖
 *      —— 否则用户自己加的注释和自定义变量会被抹掉。
 *   4. 环境变量语义（读自 CLI bundle 源码，**已实测核实**）：
 *      - `CODEBUDDY_INTERNET_ENVIRONMENT` —— 站点：`internal`(国内) / `iOA` / 省略(国际)
 *      - `CODEBUDDY_API_KEY`      —— 长期 API Key（无水印/推荐）
 *      - `CODEBUDDY_AUTH_TOKEN`   —— OAuth 令牌（会过期）
 *      - `CODEBUDDY_BASE_URL`     —— 仅专有版/自建版；**优先级最高**，会把请求指向自定义端点
 *   5. ⚠️ **凭证优先级是「weight」而非「二选一」**：
 *      CLI 内部走 `AuthenticationStoragePriority`（Heigh=9）竞速，
 *      `CODEBUDDY_AUTH_TOKEN` 命中时额外 +1（见 `_internal` 的 `e9.priority()`），
 *      且 `CODEBUDDY_API_KEY_DISABLED` 可显式关掉 API Key 通道。
 *      ⇒ **推荐只配一个**（API Key），避免"配了两个但生效的是另一个"这类幽灵问题。
 */

import fs from 'fs';
import path from 'path';
import * as authSetup from './authSetup.js';

/** 项目根 `.env` 绝对路径（与 `server/loadEnv.ts` 保持一致：都以 cwd 为基准） */
export function envFilePath(): string {
  return path.resolve(process.cwd(), '.env');
}

/** `.env.example` 模板路径（用于「生成模板」按钮） */
export function envExamplePath(): string {
  return path.resolve(process.cwd(), '.env.example');
}

// ============= 环境变量的元信息（唯一真源，前端据此渲染） =============

/** 站点取值 —— 与 `authSetup.AUTH_ENVIRONMENTS` 一一对应 */
export type InternetEnvValue = 'internal' | 'iOA';

export interface EnvVarSpec {
  /** 变量名 */
  key: string;
  /** 界面标题 */
  label: string;
  /** 是否必填（决定界面是否打「必填」角标） */
  required: boolean;
  /** 是否敏感（敏感项读取时脱敏、写入时掩码回填） */
  secret: boolean;
  /** 一句话说明 */
  hint: string;
  /** 界面使用的输入类型 */
  input: 'text' | 'password' | 'select';
  /** select 的候选（仅 input==='select' 时有效） */
  options?: Array<{ label: string; value: string }>;
  /** 该项缺失/设错时的后果（用户最容易踩的坑写在这里） */
  pitfall?: string;
  /**
   * 是否参与「凭据二选一」。
   * 参与者：`CODEBUDDY_API_KEY` / `CODEBUDDY_AUTH_TOKEN` —— 界面据此渲染"二选一"提示。
   */
  credentialGroup?: 'api-key' | 'auth-token';
}

/** ⭐ 待配置项的**唯一真源** —— 前端不再自己硬编码字段清单 */
export const ENV_VAR_SPECS: EnvVarSpec[] = [
  {
    key: 'CODEBUDDY_INTERNET_ENVIRONMENT',
    label: '站点（网络环境）',
    required: true,
    secret: false,
    input: 'select',
    options: [
      { label: 'internal — 国内站（推荐）', value: 'internal' },
      { label: 'iOA — 腾讯企业内网', value: 'iOA' },
    ],
    hint: '国内站填 internal；国际站留空；腾讯内网填 iOA。',
    pitfall:
      '⚠️ 这是官方文档点名「最常被遗漏」的一项：漏填或填错会报「鉴权失败或连到错误的服务端点」，且报错信息不会指向这里，极难排查。国内站必须为 internal。',
  },
  {
    key: 'CODEBUDDY_API_KEY',
    label: 'API Key',
    required: false,
    secret: true,
    input: 'password',
    credentialGroup: 'api-key',
    hint: '平台签发的长期密钥，不随桌面端登录状态变化（推荐）。只创建时显示一次，请立刻保存。',
    pitfall:
      '获取地址按站点选一个：国内站 https://copilot.tencent.com/profile/ · 国际站 https://www.codebuddy.ai/profile/keys · iOA https://tencent.sso.copilot.tencent.com/profile/keys',
  },
  {
    key: 'CODEBUDDY_AUTH_TOKEN',
    label: 'Auth Token',
    required: false,
    secret: true,
    input: 'password',
    credentialGroup: 'auth-token',
    hint: '既有 OAuth 令牌，会过期、需定期更换。⚠️ 与 API Key 二选一即可，两个都配时按内部优先级竞速，容易出现「配了 A 但生效的是 B」。',
    pitfall: '若同时配置了 API Key 与 Auth Token，Auth Token 的内部权重更高（Heigh+1），可能优先生效。',
  },
  {
    key: 'CODEBUDDY_BASE_URL',
    label: '自定义端点 Base URL',
    required: false,
    secret: false,
    input: 'text',
    hint: '仅专有版 / 自建版需要。留空即用官方端点。',
    pitfall:
      '⚠️ 它的优先级**高于站点设置**：一旦填写，请求会被指向该端点，站点（INTERNET_ENVIRONMENT）不再决定路由 —— 官方也把它作为「站点解析不匹配」时的 workaround。若你不是自建版，请保持留空。',
  },
];

/** 需要读写的键集合 */
const MANAGED_KEYS = ENV_VAR_SPECS.map(s => s.key);

// ============= `.env` 解析（保留注释与顺序） =============

export interface EnvFileLine {
  /** 原始行（含注释行、空行） */
  raw: string;
  /** 解析出的键（非 KEY=VALUE 行为 undefined） */
  key?: string;
  /** 解析出的值（未 unquote） */
  value?: string;
  /** 该行是否为 `# KEY=...` 形式的被注释掉的配置 */
  commentedKey?: string;
}

const LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** 去掉包裹的引号（`"x"` / `'x'`），并处理反斜杠转义的最简形态 */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function stripInlineComment(v: string): string {
  // 未被引号包裹时，`#` 之后视为行内注释
  const t = v.trim();
  const hash = t.indexOf('#');
  if (hash > 0 && !t.startsWith('"') && !t.startsWith("'")) return t.slice(0, hash).trim();
  return t;
}

export function parseEnvText(text: string): EnvFileLine[] {
  return text.split(/\r?\n/).map(raw => {
    const m = raw.match(LINE_RE);
    if (m) return { raw, key: m[1], value: unquote(stripInlineComment(m[2])) };

    // `# KEY=VALUE` —— 模板里「注释掉的默认项」写法
    const cm = raw.match(/^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (cm) return { raw, commentedKey: cm[1], value: unquote(stripInlineComment(cm[2])) };

    return { raw };
  });
}

/** 从解析结果里取键的「有效值」（未注释的行优先；没有则回落到被注释的默认值） */
function effectiveValue(lines: EnvFileLine[], key: string): { value: string; commented: boolean } | undefined {
  let commented: { value: string } | undefined;
  for (const l of lines) {
    if (l.key === key && l.value !== undefined && l.value !== '') return { value: l.value, commented: false };
    if (l.commentedKey === key && l.value !== undefined && !commented) commented = { value: l.value };
  }
  return commented ? { value: commented.value, commented: true } : undefined;
}

function mask(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 12) return '****';
  return `${secret.slice(0, 8)}****${secret.slice(-4)}`;
}

/**
 * 判断一个值是否是 `mask()` 产出的**脱敏占位符**。
 *
 * ⚠️ 这是防「把脱敏值当真值写回文件」的关键守卫（已实测踩过）：
 * 界面回填时显示的是 `ck_fy8pv****GVAo`，若用户没动这个框就提交，
 * 而这里判定失败，**真正的密钥会被这串星号覆盖**，且不可逆。
 *
 * 因此判定必须覆盖 mask() 的两种产出形态：
 *   1. 短值 → 纯 `****`
 *   2. 长值 → `前 8 位 + **** + 后 4 位`
 *
 * 判据：**值中含连续的 4 个以上 `*`**。真实凭证不会含 `*`
 * （API Key 是 `ck_` 前缀的 base62，OAuth token 亦为字母数字），
 * 所以这个判据足够安全，且不依赖前缀长度这种易变细节。
 */
export function isMaskedValue(v: string): boolean {
  return /\*{4,}/.test(v);
}


// ============= 对外：读状态 =============

export interface EnvVarState {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  input: 'text' | 'password' | 'select';
  options?: Array<{ label: string; value: string }>;
  hint: string;
  pitfall?: string;
  credentialGroup?: 'api-key' | 'auth-token';
  /** 是否已配置（`.env` 文件里存在有效值，或进程环境里存在） */
  configured: boolean;
  /** 值的来源：'file'（.env 有效行） / 'file-commented'（.env 里只是注释掉的默认值） / 'process'（仅进程环境，如启动脚本注入） / 'none' */
  source: 'file' | 'file-commented' | 'process' | 'none';
  /** 展示用值：敏感项脱敏；非敏感项明文 */
  display: string;
  /** 进程当前是否真的持有该变量（用于暴露「.env 改了但没重启」这种状态） */
  activeInProcess: boolean;
  /** ⚠️ 文件里的值 与 进程里的值 不一致（通常意味着改了 .env 但没重启） */
  drift: boolean;
}

export interface EnvFileState {
  /** `.env` 绝对路径 */
  filePath: string;
  exists: boolean;
  /** 文件字节数（是否存在内容的直观指标） */
  size: number;
  /** `.env.example` 是否存在（「生成模板」按钮用） */
  exampleExists: boolean;
  /** 逐项状态（顺序 = ENV_VAR_SPECS） */
  vars: EnvVarState[];
  /** 必填项里还没配的键名 */
  missingRequired: string[];
  /** 汇总：是否「可执行任务」（有凭据 + 站点已定） */
  ready: boolean;
  /** 为 false 时，`ready` 不可信（文件读取异常） */
  fileReadable: boolean;
  /** 读取异常说明 */
  readError?: string;
  /** 面向用户的结论文案（界面直接展示） */
  verdict: string;
  /**
   * ⭐ **最终生效的凭据是哪一条**（界面必须显式标出）。
   *
   * 这是用户最容易困惑的点：`.env` 里配了 API Key、CLI 又登录了，
   * 界面上「两个都显示已配置」，但**实际只会用其中一个** ——
   * 用户看到两个绿勾就会以为"双保险"，其实低权重的那个是纯摆设。
   *
   * 这里把 `authSetup` 观察到的事实 + CLI 内部权重表合起来给出确定结论。
   */
  effective: EffectiveCredential;
}

/** 凭据来源（与 CLI 的 `AuthenticationStoragePriority` 对应） */
export type CredentialSource = 'api-key' | 'auth-token' | 'cli-file' | 'none';

/**
 * CLI 内部的凭据权重表（**读 CLI bundle 源码实测所得**，勿凭印象改）。
 *
 * 来源：`cli/dist/codebuddy-headless.js` 的 `AuthenticationStoragePriority`
 *   Disabled=0 / Low=1 / Normal=5 / Heigh=9
 * 各 Storage 的 `priority()` 返回值：
 *   - `ApiKeyAuthenticationStorage`        → 有 Key      ⇒ Heigh(9)
 *   - `CustomTokenAuthenticationStorage`   → 有 Token    ⇒ Heigh(9)；其子类命中时 Heigh+1(10)
 *   - `FileAuthenticationStorage`          → CLI 凭据文件 ⇒ **Normal(5)**
 *
 * ⇒ 结论：`.env` 里的静态凭证**总是压过** CLI 登录凭据。
 *   API Key 与 Auth Token 之间则是一场不可预期的竞速（都 ≥9）⇒ 建议只留一个。
 */
const CREDENTIAL_WEIGHT: Record<Exclude<CredentialSource, 'none'>, number> = {
  'auth-token': 10,
  'api-key': 9,
  'cli-file': 5,
};

export interface EffectiveCredential {
  /** 最终会被采用的凭据来源 */
  source: CredentialSource;
  /** 展示名（界面直接显示） */
  label: string;
  /** 为什么是它（一句话讲清胜负依据） */
  reason: string;
  /**
   * ⚠️ 被"压制"的、已配置但不会生效的凭据来源。
   * 界面应把它们显式标为「已配置但当前不生效」，而不是简单打绿勾。
   */
  shadowed: Array<{ source: Exclude<CredentialSource, 'none'>; label: string }>;
  /** CLI 凭据的剩余有效期（毫秒）；仅当 CLI 凭据存在且未过期时有值 */
  cliExpiresInMs?: number;
  /** CLI 凭据的绝对过期时间（毫秒） */
  cliExpiresAt?: number;
  /** CLI 凭据是否已过期（过期时它连兜底都做不了） */
  cliExpired: boolean;
}

const SOURCE_LABEL: Record<Exclude<CredentialSource, 'none'>, string> = {
  'api-key': 'CODEBUDDY_API_KEY（.env）',
  'auth-token': 'CODEBUDDY_AUTH_TOKEN（.env）',
  'cli-file': 'CodeBuddy CLI 登录凭据',
};

/**
 * 计算「最终生效的凭据」。
 *
 * @param configured 哪些来源已经配置好（由 `describeEnvState` 判定）
 * @param cli         CLI 凭据的现状（由 `authSetup` 观察；`undefined` 表示不适用/读不到）
 */
export function resolveEffectiveCredential(
  configured: Array<Exclude<CredentialSource, 'none'>>,
  cli:
    | {
        /** CLI 凭据文件是否存在且可用（未过期、非登出态） */
        usable: boolean;
        expiresAt?: number;
        /** 是否已过期（用于区分「没登录」与「登录了但过期」） */
        expired?: boolean;
      }
    | undefined
): EffectiveCredential {
  // 只有"可用"的来源能参与竞速
  const candidates = configured.filter(s => {
    if (s !== 'cli-file') return true;
    // CLI 凭据必须真的可用（未过期）才算候选；过期的一律排除
    return Boolean(cli?.usable);
  });

  const cliExpiresAt = cli?.expiresAt;
  const cliExpired = Boolean(cli?.expired);
  const cliExpiresInMs =
    typeof cliExpiresAt === 'number' && !cliExpired ? cliExpiresAt - Date.now() : undefined;

  const base = {
    cliExpiresAt,
    cliExpired,
    ...(cliExpiresInMs !== undefined ? { cliExpiresInMs } : {}),
  };

  if (!candidates.length) {
    return {
      source: 'none',
      label: '无',
      reason: cliExpired
        ? 'CLI 凭据已过期，且 .env 里没有配任何凭据 ⇒ 当前无法执行任务。'
        : '没有检测到任何可用凭据 ⇒ 当前无法执行任务。',
      shadowed: [],
      ...base,
    };
  }

  // 按权重降序取最高者
  const sorted = [...candidates].sort((a, b) => CREDENTIAL_WEIGHT[b] - CREDENTIAL_WEIGHT[a]);
  const winner = sorted[0];
  const shadowed = sorted.slice(1).map(s => ({ source: s, label: SOURCE_LABEL[s] }));

  // 讲清"为什么是它" —— 分三种情形，不搞模糊表述
  let reason: string;
  if (winner === 'cli-file') {
    reason = '仅检测到 CLI 登录凭据（未配置 .env 静态凭证）⇒ 由它生效。';
  } else if (winner === 'auth-token' && candidates.includes('api-key')) {
    reason =
      'Auth Token 的内部权重高于 API Key（Heigh+1 vs Heigh）⇒ 由它生效；' +
      '两者都配时结果不可预期，建议只保留一个。';
  } else if (winner === 'api-key' && candidates.includes('auth-token')) {
    reason =
      'API Key 与 Auth Token 的内部权重接近（均 ≥ Heigh），实际生效项不可预期；' +
      '本次判定为 API Key，建议只保留一个。';
  } else {
    // 只有 .env 静态凭证，且没有"同类竞争者"
    reason = candidates.includes('cli-file')
      ? '.env 静态凭证的权重（Heigh）高于 CLI 登录凭据（Normal）⇒ CLI 凭据当前不生效。'
      : '由 .env 中唯一配置的静态凭证生效。';
  }

  // CLI 凭据即将过期的提醒（只在它确实参与竞速时才有意义）
  if (cliExpiresInMs !== undefined && cliExpiresInMs < 24 * 3600 * 1000) {
    reason += ` ⚠️ CLI 凭据将在 ${Math.max(1, Math.ceil(cliExpiresInMs / 3600000))} 小时后过期。`;
  }

  return { source: winner, label: SOURCE_LABEL[winner], reason, shadowed, ...base };
}

/**
 * 读当前 `.env` 状态。
 *
 * ⚠️ 只读文件 + 只读 `process.env`，**不发起任何网络/登录动作**。
 */
export function describeEnvState(): EnvFileState {
  const filePath = envFilePath();
  let text = '';
  let fileReadable = true;
  let readError: string | undefined;
  let size = 0;
  let exists = false;

  try {
    const st = fs.statSync(filePath);
    exists = true;
    size = st.size;
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      exists = false;
    } else {
      fileReadable = false;
      readError = `${err?.code ?? ''} ${err?.message ?? err}`.trim();
    }
  }

  const lines = fileReadable ? parseEnvText(text) : [];

  const vars: EnvVarState[] = ENV_VAR_SPECS.map(spec => {
    const fromFile = fileReadable ? effectiveValue(lines, spec.key) : undefined;
    const procRaw = process.env[spec.key];

    let source: EnvVarState['source'] = 'none';
    let rawValue = '';

    if (fromFile && !fromFile.commented && fromFile.value) {
      source = 'file';
      rawValue = fromFile.value;
    } else if (procRaw) {
      // 进程里有、但 .env 里没有有效行 ⇒ 来自启动脚本/父进程注入
      source = 'process';
      rawValue = procRaw;
    } else if (fromFile?.commented && fromFile.value) {
      source = 'file-commented';
      rawValue = fromFile.value;
    }

    const configured = Boolean(rawValue);
    const display = !configured ? '' : spec.secret ? mask(rawValue) : rawValue;

    // drift：文件有值 + 进程有值，但两者不同（敏感项无法逐字比较，改比「是否都存在」）
    let drift = false;
    if (configured && procRaw && (source === 'file' || source === 'process')) {
      drift = spec.secret ? procRaw !== rawValue : procRaw !== rawValue;
    }

    return {
      key: spec.key,
      label: spec.label,
      required: spec.required,
      secret: spec.secret,
      input: spec.input,
      options: spec.options,
      hint: spec.hint,
      pitfall: spec.pitfall,
      credentialGroup: spec.credentialGroup,
      configured,
      source,
      display,
      activeInProcess: Boolean(procRaw),
      drift,
    };
  });

  const byKey = new Map(vars.map(v => [v.key, v]));
  const hasEnvCredential = Boolean(
    byKey.get('CODEBUDDY_API_KEY')?.configured || byKey.get('CODEBUDDY_AUTH_TOKEN')?.configured
  );
  const site = byKey.get('CODEBUDDY_INTERNET_ENVIRONMENT');

  /**
   * CLI 登录凭据的现状。
   *
   * ⚠️ 这里**复用 authSetup 的观察结果**（`checkPassive()` 本身就是纯读、无副作用），
   * 而不是自己再去解析一遍凭据文件 —— 凭据的读取规则（含 `.logged-out` 标记、
   * `statSync` 区分"读不到"与"没登录"）只在 authSetup 里维护一份。
   */
  const loginStatus = (() => {
    try {
      return authSetup.checkPassive();
    } catch {
      return undefined;
    }
  })();
  const cliCredential = loginStatus?.cliCredential;
  const cliUsable = Boolean(loginStatus?.cliConfigured);
  const cliExpired = Boolean(cliCredential?.isExpired);

  const effective = resolveEffectiveCredential(
    [
      ...(byKey.get('CODEBUDDY_API_KEY')?.configured ? (['api-key'] as const) : []),
      ...(byKey.get('CODEBUDDY_AUTH_TOKEN')?.configured ? (['auth-token'] as const) : []),
      // CLI 凭据只要"存在"就纳入候选，是否可用由 resolve 内部按 usable 过滤 ——
      // 这样即使在过期态也能给出"已过期所以不生效"的准确结论
      ...(cliCredential ? (['cli-file'] as const) : []),
    ],
    cliCredential
      ? {
          usable: cliUsable,
          ...(typeof cliCredential.expiresAt === 'number' ? { expiresAt: cliCredential.expiresAt } : {}),
          expired: cliExpired,
        }
      : undefined
  );

  // 只要有任一可用凭据（env 或 CLI），就视为具备执行条件
  const hasAnyCredential = hasEnvCredential || cliUsable;
  const missingRequired = vars.filter(v => v.required && !v.configured).map(v => v.key);
  const ready = fileReadable && hasAnyCredential;

  // 结论文案：把「看得见的下一步」讲清楚
  let verdict: string;
  if (!fileReadable) {
    verdict = `⚠️ 无法读取 .env（${readError}）。此时下面的「未配置」不可信。`;
  } else if (!hasAnyCredential) {
    verdict = cliExpired
      ? '⚠️ 唯一凭据（CLI 登录）已过期，且 .env 里没有配任何凭据 ⇒ 执行任务会报「Authentication required」。请重新登录，或改用 API Key。'
      : !exists
        ? '尚未创建 .env，且未检测到 CLI 登录凭据。填入下方任一凭据并保存即可（保存后需重启看板才生效），或使用「方式二」CLI 登录。'
        : '⚠️ 缺少凭据：.env 里的 API Key / Auth Token 至少要有一个，或使用下方「方式二」CLI 登录；否则执行任务会报「Authentication required」。';
  } else if (!site?.configured) {
    verdict =
      '⚠️ 已配凭据，但站点（CODEBUDDY_INTERNET_ENVIRONMENT）为空 —— 国内站必须填 internal，否则可能鉴权失败或连错端点。';
  } else if (vars.some(v => v.drift)) {
    verdict = '✅ 配置完整。但检测到「文件里的值」与「当前进程生效的值」不一致 —— 多半是改了 .env 还没重启看板。';
  } else {
    verdict = '✅ 配置完整且已生效。';
  }

  // CLI 凭据存在但已过期 ⇒ 在结论里点明，避免用户以为"有绿勾就没问题"
  if (fileReadable && cliExpired && hasAnyCredential) {
    verdict += ' （当前由 .env 凭据支撑；CLI 凭据已过期，刷新后才会重新可用。）';
  }

  return {
    filePath,
    exists,
    size,
    exampleExists: fs.existsSync(envExamplePath()),
    vars,
    missingRequired,
    ready,
    fileReadable,
    readError,
    verdict,
    effective,
  };
}

// ============= 对外：写状态 =============

export interface WriteEnvResult {
  ok: boolean;
  /** 实际改动/新增的键 */
  changed: string[];
  /** 被清空的键 */
  cleared: string[];
  /** 写入后的文件路径 */
  filePath: string;
  /** 面向用户的提示（含「需重启」） */
  message: string;
  error?: string;
}

/**
 * 增量更新 `.env`。
 *
 * 语义：
 *   - `patch[key] === undefined`  → **不动该项**（保持原样）
 *   - `patch[key] === ''`         → **清空该项**（整行注释掉，而不是删掉行 —— 保留可读性）
 *   - `patch[key] === '<masked>'` → 视为「未修改」（前端回填的脱敏占位符，不能当真值写入）
 *   - 其它字符串                   → 写入/替换
 *
 * 写入策略：**保留原有行顺序与注释**，只替换目标键所在行；新键追加到文件末尾。
 * 绝不整文件覆盖 —— 用户自己加的注释与自定义变量必须原样保留。
 */
export function writeEnvFile(patch: Record<string, string | undefined>): WriteEnvResult {
  const filePath = envFilePath();

  /** 只接受受管的键，避免任意写文件 */
  const keys = Object.keys(patch).filter(k => MANAGED_KEYS.includes(k));
  if (!keys.length) {
    return { ok: false, changed: [], cleared: [], filePath, message: '', error: '没有可写入的字段' };
  }

  let text = '';
  let existed = false;
  try {
    text = fs.readFileSync(filePath, 'utf8');
    existed = true;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      return {
        ok: false,
        changed: [],
        cleared: [],
        filePath,
        message: '',
        error: `读取 .env 失败：${err?.code ?? ''} ${err?.message ?? err}`,
      };
    }
  }

  const lines = existed ? text.split(/\r?\n/) : [];
  const changed: string[] = [];
  const cleared: string[] = [];
  /** 已经被处理的键（防止文件里有重复键时只改第一个） */
  const handled = new Set<string>();

  const nextLines = lines.map(raw => {
    const m = raw.match(LINE_RE);
    const cm = !m ? raw.match(/^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/) : null;
    const key = m?.[1] ?? cm?.[1];
    if (!key) return raw;
    if (!keys.includes(key)) return raw;
    if (handled.has(key)) return raw; // 重复键：只改第一处
    handled.add(key);

    const incoming = patch[key];
    if (incoming === undefined) return raw;

    // 脱敏占位符 ⇒ 视为未修改，原样保留
    if (isMaskedValue(incoming)) return raw;

    const v = incoming.trim();
    if (!v) {
      // 清空：写成注释形式，保留键名可读性
      cleared.push(key);
      return `# ${key}=`;
    }

    // 含空格/特殊字符时加引号，避免解析歧义
    const needsQuote = /[\s#"'\\]/.test(v);
    const rendered = needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v;
    changed.push(key);
    return `${key}=${rendered}`;
  });

  // 文件里没有的键 ⇒ 追加
  const appended: string[] = [];
  for (const k of keys) {
    const incoming = patch[k];
    if (incoming === undefined) continue;
    if (isMaskedValue(incoming)) continue;
    if (handled.has(k)) continue;

    const v = incoming.trim();
    if (!v) {
      cleared.push(k);
      appended.push(`# ${k}=`);
      continue;
    }
    const needsQuote = /[\s#"'\\]/.test(v);
    const rendered = needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v;
    changed.push(k);
    appended.push(`${k}=${rendered}`);
  }

  if (appended.length) {
    // 末尾空行归一化后再追加，避免出现连续空行
    while (nextLines.length && nextLines[nextLines.length - 1].trim() === '') nextLines.pop();
    nextLines.push('');
    nextLines.push(...appended);
    nextLines.push('');
  }

  const output = nextLines.join('\n');

  try {
    // ⚠️ 统一 LF：`.env` 是本项目自己解析的，避免 CRLF 混入
    fs.writeFileSync(filePath, output, 'utf8');
  } catch (err: any) {
    return {
      ok: false,
      changed: [],
      cleared: [],
      filePath,
      message: '',
      error: `写入 .env 失败：${err?.code ?? ''} ${err?.message ?? err}`,
    };
  }

  console.log(`[Env] 已更新 ${filePath} — 改动: [${changed.join(', ')}] 清空: [${cleared.join(', ')}]`);

  const parts: string[] = [];
  if (changed.length) parts.push(`已写入 ${changed.join('、')}`);
  if (cleared.length) parts.push(`已清空 ${cleared.join('、')}`);
  const message =
    (parts.length ? parts.join('；') : '没有任何变化') +
    '。⚠️ 环境变量在**进程启动时**读取，需**重启看板**（重跑 start.cmd）才会生效。';

  return { ok: true, changed, cleared, filePath, message };
}
