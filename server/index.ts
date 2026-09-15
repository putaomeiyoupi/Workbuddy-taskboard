// ⚠️ 必须是**第一个 import**：它负责加载项目根的 `.env`。
// ESM 的 import 会提升，写在后面的模块（如 runtime.ts）在加载时就可能读环境变量，
// 因此这一行放在最前面才能保证 `.env` 先生效。见 server/loadEnv.ts 顶部说明。
import './loadEnv.js';
import express from "express";
// 注意：`unstable_v2_authenticate` 不在这里用了 —— 它属于「发起登录流程」，
// 由 server/authSetup.ts 统一持有，只允许用户点击触发（见该文件顶部说明）。
import { query, unstable_v2_createSession, PermissionResult, CanUseTool } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import * as db from "./db.js";
import * as hostAdapter from "./hostAdapter.js";
import type { HostSnapshot } from "./hostAdapter.js";
import * as authSetup from "./authSetup.js";
import * as envConfig from "./envConfig.js";
import * as workspaceSync from "./workspaceSync.js";
import { getWorkbuddyModelCatalog, describeCatalogSources } from "./modelCatalog.js";
import { serializeTask, parseProgressLog } from "./taskView.js";
import { getOccupancy } from "./hostOccupancy.js";
import * as hostTranscript from "./hostTranscript.js";
import * as repeat from "./repeat.js";
import { normalizeScopes, anyOverlap, describeScopes } from './scopes.js';
import { NODE_EXE, ensureNodeOnPath, describeRuntime, sanitizeInheritedEnv } from "./runtime.js";
import { probeSdkModels, getSdkStatus, isSdkKnownUnavailable } from "./sdkStatus.js";

// 尽早把 node 目录注入 PATH：兜住所有自己 spawn('node') 的子进程
// （Agent SDK 之外的路径，例如 CLI serve 内部再派生的进程）
ensureNodeOnPath();

// 清掉从宿主继承的、会干扰 CLI 子进程的变量。
// 最要命的是 SERVER__PORT：CLI 会拿它当自己的监听端口，
// 撞车后是「静默挂起无输出」，极难排查。详见 runtime.ts 的注释。
const strippedEnv = sanitizeInheritedEnv();
import {
  startScheduler,
  stopScheduler,
  isSchedulerRunning,
  runTick,
  getRunningTaskIds,
  abortRunningTask,
  emitBoardEvent,
  boardEvents,
  TICK_INTERVAL_MS,
  appendLog,
  // 恢复暂停中的循环任务时必须用它重算排期（见其注释：不能只把 paused 置 0）
  resumeRepeatSchedule,
} from "./scheduler.js";
// 长轮询授权：解除/取消挂起中的 canUseTool Promise（见 taskRunner 顶部说明）
// streamFollowup：运行中追加指令（抽屉底部输入框）
import { resolveTaskApproval, cancelTaskApproval, streamFollowup } from "./taskRunner.js";

const execAsync = promisify(exec);

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

// 权限请求超时时间（5分钟）
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 所有路由统一挂在 /api 下：避免 /api/tasks/stream 被 /api/tasks/:id 这类同前缀路由抢先匹配导致 404
const api = express.Router();

// Middleware
app.use(express.json());

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];

/**
 * 曾被硬编码成 "claude-sonnet-4" —— 那是**占位符**，WorkBuddy 侧并不存在。
 * 拿它去执行必然得到 `400 model [...] service info not found`。
 */
const LEGACY_PLACEHOLDER_MODELS = new Set([
  'claude-sonnet-4',
  'claude-sonnet-4-20250514',
  'claude-opus-4',
  'claude-3-5-sonnet',
]);

/** 判断一个模型名是否是历史占位符（不可用于执行） */
export function isPlaceholderModel(model: string | null | undefined): boolean {
  if (!model) return true;
  const m = model.trim();
  if (!m) return true;
  if (LEGACY_PLACEHOLDER_MODELS.has(m)) return true;
  // 通用 Claude 别名都不是本侧注册的模型 ID
  return /^claude-/i.test(m);
}

/**
 * 解析默认模型。
 * 优先使用**真实可用**的：SDK 模型列表 → 宿主观测 → 'auto'（CLI 支持的真实值）。
 */
function getDefaultModel(): string {
  if (cachedModels.length > 0) return cachedModels[0].modelId;
  // 宿主机上**真实跑过**的模型：可派发性最可靠，优先于配置里的默认档位
  const host = hostAdapter.getObservedModels();
  if (host.length > 0) return host[0];
  // 产品配置里的默认模型（桌面端打开时选中的那个）
  const catalog = getWorkbuddyModelCatalog();
  if (catalog?.defaultModel) return catalog.defaultModel;
  return 'auto';
}

// 健康检查
api.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * 登录状态查询（**被动 / 无副作用**）
 * ============================================================
 * ⚠️ 2026-09-14 修正：此前这里直接调用了 `unstable_v2_authenticate()`，
 * 而该 API 的语义是「**发起登录流程**」而不是「查询状态」—— 未登录时
 * CLI 子进程会自己打开浏览器（win32 走 `rundll32 url,OpenURL`），
 * 并且硬编码了 `environment: 'external'`（国际站 www.codebuddy.ai）。
 * 结果：**一进设置页就弹国际站登录页**。
 *
 * 现在本端点只读本地信息，不做任何网络/浏览器动作。
 * 真正的登录由用户点击按钮后走 `POST /api/login/start`。
 * 逻辑集中在 `server/authSetup.ts`（唯一真源）。
 */
api.get("/check-login", (_req, res) => {
  try {
    res.json(authSetup.checkPassive());
  } catch (error: any) {
    console.error("[Check Login] 被动检查失败:", error);
    res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * 发起 CodeBuddy 登录（**仅由用户点击触发**）
 * body: { environment: 'internal' | 'external' | 'ioa' }
 * body 省略 environment 时使用 server/authSetup.ts 的 defaultEnvironment()（跟随宿主）
 *
 * 立即返回；登录在后台进行，进度用 `GET /api/login/status` 轮询。
 */
api.post("/login/start", (req, res) => {
  const environment = req.body?.environment ?? authSetup.defaultEnvironment();
  const result = authSetup.startLogin(environment);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

/** 查询登录进度 */
api.get("/login/status", (_req, res) => {
  res.json(authSetup.getLoginState());
});

/** 放弃当前登录尝试 */
api.post("/login/cancel", (_req, res) => {
  res.json(authSetup.cancelLogin());
});

/**
 * 环境变量配置状态（**被动 / 只读**）
 * ============================================================
 * 供设置页「配置环境变量」展示当前状态 —— 此前点开是**全空白**，
 * 用户看不出已配了什么、哪项必填、以及站点那项为什么不能漏。
 *
 * 返回：
 *   - `filePath` / `exists` / `size` —— `.env` 的落盘情况
 *   - `vars[]` —— 逐项：是否已配、值来源（文件/仅进程）、脱敏展示、坑位说明
 *   - `missingRequired` / `ready` / `verdict` —— 汇总结论
 *
 * ⚠️ 凭证一律脱敏，**不返回完整密钥**；非敏感项（站点 / 端点）返回明文。
 */
api.get("/env-config", (_req, res) => {
  try {
    res.json(envConfig.describeEnvState());
  } catch (error: any) {
    console.error("[Env Config] 读取失败:", error);
    res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * 保存环境变量配置（**写入项目根 `.env`**）
 * ============================================================
 * ⚠️ 2026-09-14 修正：此前这里**只写 `process.env`（内存）**，
 * 重启即丢，且与 `server/loadEnv.ts`（读 `.env`）是两条路 ——
 * 用户以为存下了，下次启动又回到旧值。
 *
 * 现在真正落到 `.env` 文件（保留原有注释，只替换目标键行）。
 * 写入用「合并」语义：body 里**没出现的键不动**，空字符串表示清空。
 *
 * ⚠️ 环境变量在**进程启动时**读取 ⇒ 保存后必须重启看板才生效，
 * 返回值里的 `message` 已明确告知，界面需原样展示。
 */
api.post("/env-config", (req, res) => {
  const body = req.body ?? {};
  const patch: Record<string, string | undefined> = {};

  for (const spec of envConfig.ENV_VAR_SPECS) {
    if (!Object.prototype.hasOwnProperty.call(body, spec.key)) continue;
    const v = body[spec.key];
    if (v === undefined || v === null) continue;
    patch[spec.key] = String(v);
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, error: '没有可写入的字段' });
  }

  const result = envConfig.writeEnvFile(patch);
  if (!result.ok) return res.status(500).json(result);

  // 文件已变 ⇒ 模型缓存作废（站点/端点可能变了）
  cachedModels = [];

  res.json({ ...result, state: envConfig.describeEnvState() });
});

/**
 * ⚠️ **兼容保留（已弃用）**：旧的「只写内存」端点
 * ============================================================
 * 前端已改用 `POST /api/env-config`。这里保留是为避免旧页面/书签 404，
 * 行为保持原样（**仅当前进程有效、重启即丢**），并在响应里明确标注弃用，
 * 引导调用方迁移。新代码**不要**再用它。
 */
api.post("/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;

  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }

  const configuredVars: string[] = [];

  // 设置环境变量（仅在当前进程有效）
  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }

  // 清除模型缓存，以便重新获取
  cachedModels = [];

  res.json({
    success: true,
    deprecated: true,
    message: `已设置: ${configuredVars.join(', ')}`,
    note:
      '⚠️ 此端点已弃用：它只改当前进程内存，重启即丢。请改用 POST /api/env-config（会写入项目根 .env）。',
  });
});

// 获取可用模型列表
//
// 本地执行器（Agent SDK）能跑的模型。SDK 不可用时返回空清单 + 原因，
// 让界面明确禁用，而不是给出假选项。
//
// ⚠️ 绝不硬编码 `claude-sonnet-4` —— 那不是 WorkBuddy 注册的模型 ID，
//    用它派发会得到 `400 model [...] service info not found`。
//
// （原先这里还优先返回 WorkBuddy 产品配置的模型目录、取不到再回落宿主观测值；
//   workbuddy 执行器已下线，回落函数 `buildModelsFallback`
//   与 `markRecommended` 一并移除。）
api.get("/models", async (req, res) => {
  /**
   * 模型清单 = Agent SDK 能跑的模型（本地执行器的实际能力）。
   *
   * ⚠️ 原先还按 executor 区分「WorkBuddy 宿主能接的模型」并给常用项打标记 ——
   * workbuddy 执行器已下线⇒ 现在只有这一份清单。
   */
  const executor = 'local';

  const status = await probeSdkModels();
  if (status.available && status.models?.length) {
    cachedModels = status.models as any[];
    const list = (cachedModels as any[]).map((m: any) => ({
      modelId: String(m?.modelId ?? m?.id ?? m),
      name: String(m?.name ?? m?.modelId ?? m?.id ?? m),
      description: typeof m?.description === 'string' ? m.description : undefined,
      recommended: true,
    }));
    return res.json({
      models: list,
      defaultModel: list[0]?.modelId ?? getDefaultModel(),
      source: 'sdk',
      executor,
    });
  }
  // 本地 SDK 不可用：返回空清单 + 原因，让界面明确禁用而不是给出假选项
  return res.json({
    models: [],
    defaultModel: getDefaultModel(),
    source: status.coolingDown ? 'sdk-cooldown' : 'sdk-unavailable',
    executor,
    reason: status.reason ?? '本地 Agent SDK 当前不可用',
  });
});

/** 排障：模型目录的来源与候选配置位置 */
api.get("/models/sources", (_req, res) => {
  res.json({
    catalog: getWorkbuddyModelCatalog(),
    candidates: describeCatalogSources(),
  });
});

// ============= 会话 API =============

// 获取所有会话（包含消息数量）
api.get("/sessions", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 获取单个会话及其消息
api.get("/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    const messages = db.getMessagesBySession(sessionId);
    
    // 解析 tool_calls JSON
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null
    }));
    
    res.json({ session, messages: parsedMessages });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 创建新会话
api.post("/sessions", (req, res) => {
  try {
    const { model = getDefaultModel(), title = "新对话" } = req.body;
    const now = new Date().toISOString();
    
    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
      sdk_session_id: null,
      created_at: now,
      updated_at: now
    });
    
    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

// 更新会话
api.patch("/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model } = req.body;
    
    const success = db.updateSession(sessionId, { title, model });
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

// 删除会话
api.delete("/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = db.deleteSession(sessionId);
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// ============= 聊天 API =============

// 权限响应 API
api.post("/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;
  
  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);
  
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }
  
  // 清除请求
  pendingPermissions.delete(requestId);
  
  if (behavior === 'allow') {
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input
    });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: message || '用户拒绝了此操作'
    });
  }
  
  res.json({ success: true });
});

// 发送消息并获取流式响应
api.post("/chat", async (req, res) => {
  const { sessionId, message, model, systemPrompt, cwd, permissionMode } = req.body;
  
  // 请求日志
  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);
  console.log(`[Chat] CWD: ${cwd || 'default'}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();
  
  if (!session) {
    // 创建新会话
    console.log(`[Chat] 创建新会话`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      model: model || getDefaultModel(),
      sdk_session_id: null,  // 稍后从 SDK 获取
      created_at: now,
      updated_at: now
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}`);
  }

  const selectedModel = model || session.model;
  
  // 获取 SDK session ID（用于恢复对话）
  const sdkSessionId = session.sdk_session_id;

  // 创建用户消息 ID 和助手消息 ID
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 保存用户消息到数据库
  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: message,
      model: null,
      created_at: now,
      tool_calls: null
    });
    console.log(`[Chat] 用户消息已保存: ${userMessageId}`);
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 默认系统提示词
  const defaultSystemPrompt = "你是一个专业的AI助手，善于帮助用户解决各种问题。请用简洁清晰的方式回答问题。";
  
  // 工作目录：优先使用请求中的 cwd，否则使用当前目录
  const workingDir = cwd || process.cwd();

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Resume: ${sdkSessionId || 'none'}`);
    console.log(`[Chat] - CWD: ${workingDir}`);
    console.log(`[Chat] - PermissionMode: ${permissionMode || 'default'}`);
    
    // 创建 canUseTool 回调
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.log(`[Permission] Tool request: ${toolName}`);
      console.log(`[Permission] Input:`, JSON.stringify(input, null, 2));
      
      // bypassPermissions 模式直接放行
      if (permissionMode === 'bypassPermissions') {
        console.log(`[Permission] Bypassing permissions for ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      }
      
      // 创建权限请求
      const requestId = uuidv4();
      const permissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        sessionId: session.id,
        timestamp: Date.now()
      };
      
      // 发送权限请求到前端
      res.write(`data: ${JSON.stringify({ 
        type: "permission_request", 
        ...permissionRequest
      })}\n\n`);
      
      // 创建 Promise 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        const pending: PendingPermission = {
          resolve,
          reject,
          toolName,
          input,
          sessionId: session.id,
          timestamp: Date.now()
        };
        
        pendingPermissions.set(requestId, pending);
        
        // 设置超时
        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            console.log(`[Permission] Request timeout: ${requestId}`);
            resolve({
              behavior: 'deny',
              message: '权限请求超时'
            });
          }
        }, PERMISSION_TIMEOUT);
      });
    };
    
    // 使用 Query API 发送消息
    // 如果有 sdk_session_id，使用 resume 恢复对话上下文
    const stream = query({
      prompt: message,
      options: {
        cwd: workingDir,
        model: selectedModel,
        maxTurns: 10,
        systemPrompt: systemPrompt || defaultSystemPrompt,
        permissionMode: permissionMode || 'default',
        canUseTool,
        // 显式指定 node 运行时（本机 PATH 无 node，否则 spawn ENOENT）
        executable: NODE_EXE,
        ...(sdkSessionId ? { resume: sdkSessionId } : {})  // 使用 resume 恢复对话
      }
    });

    let fullResponse = "";
    let toolCalls: Array<{ 
      id: string; 
      name: string; 
      input?: Record<string, unknown>;
      status: string; 
      result?: string;
      isError?: boolean;
    }> = [];
    let newSdkSessionId: string | null = null;  // 用于存储 SDK 返回的 session_id

    // 发送会话ID和消息ID
    res.write(`data: ${JSON.stringify({ 
      type: "init", 
      sessionId: session.id, 
      userMessageId, 
      assistantMessageId,
      model: selectedModel 
    })}\n\n`);

    // 当前正在执行的工具 ID（用于匹配 tool_result）
    let currentToolId: string | null = null;

    // 统一处理工具结果：更新 toolCalls 状态并推送 SSE 事件
    const applyToolResult = (
      toolId: string | null,
      content: unknown,
      isError: boolean,
    ) => {
      const resolvedId = toolId || currentToolId;
      console.log(`[Stream] Tool result: tool_use_id=${resolvedId}, is_error=${isError}`);

      const tool =
        toolCalls.find(t => t.id === resolvedId) ||
        toolCalls[toolCalls.length - 1];
      if (tool) {
        tool.status = isError ? "error" : "completed";
        tool.isError = isError;
        tool.result =
          typeof content === "string" ? content : JSON.stringify(content ?? "");
        res.write(
          `data: ${JSON.stringify({
            type: "tool_result",
            toolId: tool.id,
            content: tool.result,
            isError,
          })}\n\n`,
        );
      }
      currentToolId = null;
    };

    // 处理流式响应
    for await (const msg of stream) {
      console.log("[Stream] Message type:", msg.type, msg);
      
      // 处理 system 消息，获取 SDK 的 session_id
      if (msg.type === "system" && (msg as any).subtype === "init") {
        newSdkSessionId = (msg as any).session_id;
        console.log(`[Stream] Got SDK session_id: ${newSdkSessionId}`);
        
        // 保存 SDK session_id 到数据库（如果是新的）
        if (newSdkSessionId && newSdkSessionId !== sdkSessionId) {
          db.updateSession(session.id, { sdk_session_id: newSdkSessionId });
          console.log(`[Stream] Saved SDK session_id to database`);
        }
      } else if (msg.type === "assistant") {
        const content = msg.message.content;

        if (typeof content === "string") {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              fullResponse += block.text;
              res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
            } else if (block.type === "tool_use") {
              currentToolId = block.id || uuidv4();
              const toolInput = (block as any).input || {};
              console.log(`[Stream] Tool use: id=${currentToolId}, name=${block.name}`);
              console.log(`[Stream] Tool input:`, JSON.stringify(toolInput, null, 2));
              
              const toolCall = { 
                id: currentToolId, 
                name: block.name, 
                input: toolInput,
                status: "running" 
              };
              toolCalls.push(toolCall);
              res.write(`data: ${JSON.stringify({ 
                type: "tool", 
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
                status: toolCall.status
              })}\n\n`);
            }
          }
        }
      } else if (msg.type === "user") {
        // SDK 通过 UserMessage 回传工具执行结果：
        // message.content 数组中包含 type === 'tool_result' 的内容块
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              applyToolResult(
                block.tool_use_id,
                block.content,
                block.is_error || false,
              );
            }
          }
        }
      } else if ((msg as any).type === "tool_result") {
        // 兼容分支：部分 SDK 版本/中间层会直接抛出扁平结构的 tool_result
        const msgAny = msg as any;
        applyToolResult(
          msgAny.tool_use_id || currentToolId,
          msgAny.content,
          msgAny.is_error || false,
        );
      } else if (msg.type === "result") {
        // 完成时确保所有工具都标记为完成
        toolCalls.forEach(tool => {
          if (tool.status === "running") {
            tool.status = "completed";
            res.write(`data: ${JSON.stringify({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ type: "done", duration: msg.duration_ms, cost: msg.total_cost_usd })}\n\n`);
      }
    }

    // 保存助手消息到数据库
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
    });

    // 更新会话标题（如果是第一条消息）
    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, { 
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel
      });
    }

    console.log(`[Chat] 请求完成 ✓`);
    res.end();
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Name:`, error?.name);
    console.error(`[Chat] Error Message:`, error?.message);
    console.error(`[Chat] Error Code:`, error?.code);
    console.error(`[Chat] Error Stack:`, error?.stack);
    console.error(`[Chat] Full Error:`, JSON.stringify(error, null, 2));
    
    const errorMessage = error?.message || "处理请求时发生错误";
    res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
    res.end();
  }
});

// ============================================================
// 任务看板 API
// ============================================================

// ---------- 工作空间 ----------

api.get("/workspaces", (req, res) => {
  res.json(db.getAllWorkspaces());
});

api.post("/workspaces", (req, res) => {
  const { name, path: wsPath, max_concurrency, description, color } = req.body || {};
  if (!name || !wsPath) {
    return res.status(400).json({ error: "name 与 path 为必填项" });
  }
  const now = new Date().toISOString();
  const ws: db.DbWorkspace = {
    id: uuidv4(),
    name,
    path: wsPath,
    max_concurrency: typeof max_concurrency === 'number' && max_concurrency > 0 ? max_concurrency : 1,
    description: description ?? null,
    color: color ?? null,
    created_at: now,
  };
  /**
   * 同一路径只允许一个工作空间（同路径两个 id 会破坏调度互锁，见 db.ts 的 v6 迁移）。
   * 重复时**幂等返回既有那条**并显式标记 `deduped`，让调用方能给出"已存在、未重复创建"
   * 这类准确提示 —— 直接 409 会让「从宿主同步」这种批量场景把已有项也当失败。
   */
  const { workspace, deduped } = db.createWorkspace(ws);
  res.json({ ...workspace, deduped });
});

api.patch("/workspaces/:id", (req, res) => {
  const ok = db.updateWorkspace(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: "工作空间不存在或无可更新字段" });
  res.json(db.getWorkspace(req.params.id));
});

api.delete("/workspaces/:id", (req, res) => {
  const inUse = db.countTasksInWorkspace(req.params.id, [
    'todo', 'in_progress', 'scheduled',
  ]);
  if (inUse > 0) {
    return res.status(409).json({
      error: `该工作空间下还有 ${inUse} 个未完结任务，无法删除`,
      inUse,
    });
  }
  const ok = db.deleteWorkspace(req.params.id);
  if (!ok) return res.status(404).json({ error: "工作空间不存在" });
  res.json({ success: true });
});

/**
 * 看板 ↔ WorkBuddy 工作空间差异（只读）。
 *
 * 用户诉求：「两边应该保持一致，除非有特别原因」。
 * 这里把「哪边多、多的是什么、是否重复、目录还在不在、有没有任务引用」一次讲清楚，
 * 由界面逐项让用户确认 —— 不做任何隐式删除。
 */
api.get("/workspaces/reconcile", (_req, res) => {
  try {
    res.json(workspaceSync.diffWorkspaces());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * 应用工作空间同步（**逐项显式**，全部由用户在前端确认后传入）。
 * body: { mergeDuplicates?, importMissing?, removeIds?, reassignTo? }
 *
 * ⚠️ 不传 `reassignTo` 时，只要还有任务引用该空间就**拒绝删除**并报出任务数，
 * 避免"只想删个空间"结果任务一起没了。
 */
api.post("/workspaces/sync", (req, res) => {
  try {
    const { mergeDuplicates, importMissing, removeIds, reassignTo } = req.body || {};
    if (removeIds !== undefined && !Array.isArray(removeIds)) {
      return res.status(400).json({ error: "removeIds 必须是数组" });
    }
    const report = workspaceSync.applyWorkspaceSync({
      mergeDuplicates: Boolean(mergeDuplicates),
      importMissing: Boolean(importMissing),
      removeIds: (removeIds as string[]) ?? [],
      reassignTo: reassignTo === undefined ? undefined : (reassignTo as string | null),
    });
    res.json({ ok: true, report });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ---------- 全局设置 ----------

api.get("/settings", (req, res) => {
  res.json({
    ...db.getAllSettings(),
    global_concurrency: db.getGlobalConcurrency(),
  });
});

api.patch("/settings", (req, res) => {
  const { global_concurrency } = req.body || {};
  if (global_concurrency !== undefined) {
    const n = Number(global_concurrency);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: "global_concurrency 必须为大于等于 1 的数字" });
    }
    db.setSetting('global_concurrency', String(Math.floor(n)));
  }
  res.json({
    ...db.getAllSettings(),
    global_concurrency: db.getGlobalConcurrency(),
  });
});

// ---------- 任务 CRUD ----------

/** 把数据库行转成前端友好的对象（解析 JSON 字段、附带工作空间信息） */
/**
 * 序列化任务给前端。
 *
 * ⚠️ `decision_*` 三个字段现在是**派生值**，由 `interactions` 表算出来：
 *   - `decision_prompt` / `decision_options` ← 当前待处理的交互
 *   - `decision_answer`                      ← 最近一次已答复的交互
 * tasks 表上的同名列是历史遗留（迁移来源），**读取时不看它们**。
 * 这样前端不用改动，数据库却是范式化的。
 */
// serializeTask / parseJsonArray / parseProgressLog 已抽到 server/taskView.ts ——
// 唯一实现，scheduler 的 SSE 事件也必须走它（否则原始行会把前端整块看板打挂）。
// 详见 taskView.ts 顶部注释。

/**
 * 宿主快照的安全包装：宿主不可读取时返回降级快照，绝不抛异常。
 * 看板的可用性不应受宿主状态影响。
 */
function safeHostSnapshot(): HostSnapshot {
  try {
    return hostAdapter.getHostSnapshot();
  } catch (err: any) {
    console.warn("[Host] 快照读取失败，已降级:", err?.message || err);
    return {
      available: false,
      hostDir: "",
      error: err?.message || "宿主数据读取失败",
      workspaces: [],
      workingSessions: [],
      awaitingSessions: [],
      finishedSessions: [],
      errorSessions: [],
      recentSessions: [],
      automations: [],
      latestRuns: {},
      stats: {
        workspaces: 0,
        sessionsTotal: 0,
        sessionsWorking: 0,
        sessionsAwaiting: 0,
        sessionsFinished: 0,
        sessionsErrored: 0,
        automationsActive: 0,
      },
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * 生成宿主快照的轻量指纹，用于"内容变化才推送"。
 * 只取影响展示的字段，避免把每个会话的完整对象都序列化一遍。
 */
function hostSnapshotHash(snap: HostSnapshot): string {
  if (!snap.available) return `unavailable:${snap.error ?? ""}`;
  const parts: string[] = [
    `ws:${snap.stats.workspaces}`,
    `auto:${snap.stats.automationsActive}`,
    `work:${snap.stats.sessionsWorking}`,
    `await:${snap.stats.sessionsAwaiting}`,
    `fin:${snap.stats.sessionsFinished}`,
    `err:${snap.stats.sessionsErrored}`,
  ];
  // 进行中会话的身份 + 活跃度
  for (const s of snap.workingSessions) {
    /**
     * 🔴 绝不能把 `idleMs` 放进指纹。
     *
     * 它是 `now - last_activity_at` 的**派生值**，每 tick 都在增长 ⇒ 指纹每 3 秒必变
     * ⇒ 无脑推送 24KB ⇒ 前端每 3 秒重算整棵宿主卡片子树。
     * 实测代价（2026-09-15）：Microsoft Edge 153 在这个负载下约 35 秒直接崩渲染进程
     * （`STATUS_ACCESS_VIOLATION`，零 JS 报错）；同页面在 Chromium 151 上完全正常。
     *
     * 用能表达「真的变化了」的字段替代：
     *   - `last_activity_at`：会话有动作时才变（它的变化才会影响卡片上的「X 分钟前活动」）
     *   - `isStale`：跨过僵尸阈值时才变（卡片要换警示样式）
     * 时间单纯流逝 ⇒ 三者都不变 ⇒ 不推送，这正是期望行为。
     */
    parts.push(
      `${s.id}:${s.status}:${s.last_activity_at ?? s.updated_at ?? 0}:${s.isStale ? 1 : 0}`
    );
  }
  // 等用户回应的会话（待决策列）—— 它从 working 变过来时 sessionsWorking 会变，
  // 但"新增一个 pending"未必影响其它计数，所以身份也要进指纹
  for (const s of snap.awaitingSessions ?? []) {
    parts.push(`a:${s.id}:${s.status}:${s.updated_at}`);
  }
  // 「已完成」列的会话身份 + 更新时间。
  // ⚠️ 必须进指纹：否则「一个会话结束、另一个同时开始」时
  // sessionsWorking 与 sessionsFinished 可能都没变 → 不推送 → 界面停在旧数据。
  for (const s of snap.finishedSessions) {
    parts.push(`f:${s.id}:${s.status}:${s.updated_at}`);
  }
  // 出错会话（归「待办」列）同理：不进指纹的话，状态变化不会被推送
  for (const s of snap.errorSessions ?? []) {
    parts.push(`e:${s.id}:${s.status}:${s.updated_at}`);
  }
  // 定时任务的重排期 / 编辑都要能触发推送
  for (const a of snap.automations) {
    const run = snap.latestRuns[a.id];
    // ⚠️ 名称与 updated_at 必须进指纹：看板支持编辑自动化（写库会更新 updated_at），
    //    只算 next_run_at 的话"只改了名字/指令"指纹不变 → 不推送 → 卡片还显示旧名字
    parts.push(
      `${a.id}:${a.status}:${a.name}:${a.updated_at}:${a.next_run_at ?? 0}:${run?.status ?? ""}:${run?.updated_at ?? 0}`
    );
  }
  return parts.join("|");
}

api.get("/tasks", (req, res) => {
  const tasks = db.getAllTasks().map(serializeTask);
  res.json(tasks);
});

// 注意：必须定义在 "/tasks/:id" 之前，否则 "stream" 会被当作 :id 抢先匹配而 404
api.get("/tasks/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // 建连即下发一次全量快照，前端无需额外拉取
  res.write(
    `data: ${JSON.stringify({
      type: "snapshot",
      payload: {
        tasks: db.getAllTasks().map(serializeTask),
        host: safeHostSnapshot(),
      },
      at: new Date().toISOString(),
    })}\n\n`
  );

  /**
   * 宿主快照轮询：与调度 tick 同频（3s），**只有内容变化时才推送**，避免无谓流量。
   *
   * ⚠️ 「内容变化」的判定必须只基于**真实变化**的字段 —— 见 `hostSnapshotHash` 里
   *    关于 `idleMs` 的说明：把派生值算进去会让它每 3 秒都"变化"，
   *    而这既不省流量，还会把前端拖进无意义的重渲染（实测能在 Edge 153 上打崩渲染进程）。
   *
   * `hash` 一并下发：前端据此再做一次判重，避免"服务端说没变、前端还是重渲染"。
   */
  let lastHostHash = "";
  const hostPoller = setInterval(() => {
    try {
      const snap = safeHostSnapshot();
      const hash = hostSnapshotHash(snap);
      if (hash !== lastHostHash) {
        lastHostHash = hash;
        res.write(
          `data: ${JSON.stringify({
            type: "host_snapshot",
            payload: snap,
            hash,
            at: new Date().toISOString(),
          })}\n\n`
        );
      }
    } catch {
      // 宿主不可用时静默跳过，不影响看板自身事件流
    }
  }, TICK_INTERVAL_MS);

  const onEvent = (event: any) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 连接已断开
    }
  };
  boardEvents.on("event", onEvent);

  // 心跳，防止代理层断开空闲连接
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // ignore
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(hostPoller);
    boardEvents.off("event", onEvent);
    res.end();
  });
});

api.get("/tasks/:id", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  res.json(serializeTask(task));
});

api.post("/tasks", (req, res) => {
  const {
    title,
    prompt,
    workspace_id,
    model,
    agent_id,
    priority,
    scheduled_at,
    depends_on,
    // 注：请求体里的 executor 已忽略 —— workbuddy 执行器下线后只剩本地执行器
    isolation,
    scopes,
    // 定期循环（只作用于看板自建任务；宿主定时任务仍只读）
    repeat_mode,
    repeat_spec,
    repeat_until,
    repeat_limit,
  } = req.body || {};

  if (!title || !prompt) {
    return res.status(400).json({ error: "title 与 prompt 为必填项" });
  }

  // 独立工作树此前只有 workbuddy 执行器实现过，该执行器已下线
  // ⇒ 现在没有任何执行器会真正创建独立目录，声明 worktree 必须在入口挡掉，
  //   否则会出现「调度器放开了互锁、实际却没有隔离」的并发写风险。
  if (isolation === "worktree") {
    return res.status(400).json({
      error: "「独立工作树」当前不可用（原实现的执行器已下线），请改用「共享目录」",
    });
  }
  if (workspace_id && !db.getWorkspace(workspace_id)) {
    return res.status(400).json({ error: "指定的工作空间不存在" });
  }

  /**
   * 定期循环的入口校验。
   *
   * ⚠️ 规格无效必须**在入口 400 挡掉**，不能兜一个默认值：否则用户以为设了「每周三」，
   *    实际存进去的是无法计算的值 ⇒ 永远不触发，而且没有任何报错线索。
   */
  const mode = repeat.normalizeRepeatMode(repeat_mode);
  let spec: repeat.RepeatSpec | null = null;
  if (mode !== "none") {
    spec = repeat.normalizeRepeatSpec(mode, repeat_spec);
    if (!spec) {
      return res.status(400).json({ error: "循环规则无效，请检查频率/时刻/周几等设置" });
    }
  }

  const repeatUntilIso = (() => {
    if (!repeat_until) return null;
    const d = new Date(repeat_until);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  })();
  if (repeat_until && !repeatUntilIso) {
    return res.status(400).json({ error: "循环截止时间格式无效" });
  }

  const repeatLimitNum = (() => {
    if (repeat_limit === undefined || repeat_limit === null || repeat_limit === "") return null;
    const n = Number(repeat_limit);
    return Number.isInteger(n) && n > 0 ? n : NaN;
  })();
  if (Number.isNaN(repeatLimitNum)) {
    return res.status(400).json({ error: "最多执行次数必须是大于 0 的整数" });
  }

  const now = new Date().toISOString();
  const prio = Number.isFinite(Number(priority)) ? Number(priority) : 1;

  /**
   * 首次执行时刻：
   *   ① 显式给了 `scheduled_at` ⇒ 尊重用户（可作为"首次执行"覆盖）
   *   ② 否则由循环规格从「现在」往后推（用户不需要手填第一次时间）
   *   ③ 两者都没有 ⇒ 不是定时任务，直接进待办
   */
  const firstRunIso = (() => {
    if (scheduled_at) {
      const d = new Date(scheduled_at);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (mode !== "none" && spec) {
      const until = repeatUntilIso ? new Date(repeatUntilIso) : null;
      const next = repeat.computeNextRun(spec, new Date(now), until);
      return next ? next.toISOString() : null;
    }
    return null;
  })();

  if (scheduled_at && !firstRunIso) {
    return res.status(400).json({ error: "定时执行时间格式无效" });
  }
  // 配了循环却算不出首次时间（例如「每月 31 日 + 截止在下周」）⇒ 明确拒绝，
  // 否则会静默落成「待办」，用户以为配上了循环
  if (mode !== "none" && !firstRunIso) {
    return res.status(400).json({
      error: "按当前循环规则与截止时间算不出任何一次执行，请放宽截止时间或调整规则",
    });
  }

  const hasSchedule = !!firstRunIso;

  // 有定时时间 → 直接落在「自动化定时」板块；否则进入「待办」
  const status: db.TaskStatus = hasSchedule ? 'scheduled' : 'todo';

  const maxSort = db.getAllTasks().reduce((m, t) => Math.max(m, t.sort_order), 0);

  const task: db.DbTask = {
    id: uuidv4(),
    title,
    prompt,
    workspace_id: workspace_id ?? null,
    model: model || getDefaultModel(),
    agent_id: agent_id ?? null,
    status,
    priority: Math.max(0, Math.min(2, prio)),
    scheduled_at: firstRunIso,
    // 注意：depends_on 列**不再作为真源**，仅保留字段占位以免影响既有插入语句；
    // 真正的依赖写在建任务之后，经 setDependencies 落到 join 表。
    depends_on: null,
    decision_prompt: null,
    decision_options: null,
    decision_answer: null,
    session_id: null,
    sdk_session_id: null,
    result: null,
    error: null,
    progress_log: null,
    retry_count: 0,
    sort_order: maxSort + 1,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
    executor: 'local',
    host_session_id: null,
    host_job_id: null,
    isolation: 'shared', // worktree 已不可用（上方已 400 挡掉）⇒ 一律共享目录
    worktree_path: null,
    wait_reason: null,
    run_state: null,
    // 先占位；真正的值在下方校验通过后写入
    scopes: null,
    // 定期循环：入口已校验过 spec，这里直接落库
    repeat_mode: mode,
    repeat_spec: spec ? JSON.stringify(spec) : null,
    repeat_until: repeatUntilIso,
    repeat_limit: repeatLimitNum,
    repeat_count: 0,
    repeat_paused: 0,
    repeat_last_at: null,
  };

  // ---- 修改范围：校验不通过直接 400 ----
  // ⚠️ 不静默丢弃非法项：用户声明了范围却没生效，
  // 会让任务被错误地判断为「无冲突」而并行执行。
  let normalizedScopes: string[] = [];
  if (scopes !== undefined) {
    const ws = task.workspace_id ? db.getWorkspace(task.workspace_id) : undefined;
    try {
      normalizedScopes = normalizeScopes(scopes, ws?.path ?? null);
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || '修改范围不合法' });
    }
  }
  task.scopes = normalizedScopes.length > 0 ? JSON.stringify(normalizedScopes) : null;

  db.createTask(task);

  // 依赖写真源：setDependencies 会做去重、悬空引用过滤与环路检测。
  // 依赖非法（如成环）不阻断建任务 —— 任务本身有效，只是依赖没设上，
  // 并在日志里说明，避免用户建了任务却不知道为什么没被调度。
  if (Array.isArray(depends_on) && depends_on.length > 0) {
    try {
      const n = db.setDependencies(task.id, depends_on);
      if (n < depends_on.length) {
        console.warn(
          `[API] 任务 ${task.id} 的依赖有 ${depends_on.length - n} 项被忽略（不存在/自环/重复）`
        );
      }
    } catch (err: any) {
      console.warn(`[API] 任务 ${task.id} 依赖设置失败：${err?.message || err}`);
    }
  }

  const serialized = serializeTask(task);
  emitBoardEvent('task_created', { task: serialized });
  res.json(serialized);
});

const TASK_UPDATABLE_KEYS: Array<keyof db.TaskUpdatableFields> = [
  'title', 'prompt', 'workspace_id', 'model', 'agent_id', 'status', 'priority',
  'scheduled_at', 'depends_on', 'decision_prompt', 'decision_options',
  'decision_answer', 'session_id', 'sdk_session_id', 'result', 'error',
  'progress_log', 'retry_count', 'sort_order', 'started_at', 'finished_at',
  'executor', 'host_session_id', 'scopes',
];

/** 需要序列化成 JSON 字符串落库的数组字段 */
const JSON_ARRAY_FIELDS = ['depends_on', 'decision_options'] as const;

api.patch("/tasks/:id", (req, res) => {
  const existing = db.getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: "任务不存在" });

  const body = req.body || {};
  const updates: Partial<db.TaskUpdatableFields> = {};

  for (const key of TASK_UPDATABLE_KEYS) {
    if (body[key] !== undefined) {
      (updates as any)[key] = body[key];
    }
  }

  // 数组字段：统一序列化为 JSON 字符串，避免 better-sqlite3 绑定数组报错
  for (const field of JSON_ARRAY_FIELDS) {
    if (body[field] !== undefined) {
      const val = body[field];
      if (Array.isArray(val)) {
        (updates as any)[field] = val.length > 0 ? JSON.stringify(val) : null;
      } else if (val === null || val === '') {
        (updates as any)[field] = null;
      }
    }
  }

  // 修改范围：与建任务同一套校验；不合法直接 400，不落半成品
  if (body.scopes !== undefined) {
    delete (updates as any).scopes;
    const ws = existing.workspace_id ? db.getWorkspace(existing.workspace_id) : undefined;
    try {
      const norm = normalizeScopes(body.scopes, ws?.path ?? null);
      (updates as any).scopes = norm.length > 0 ? JSON.stringify(norm) : null;
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || '修改范围不合法' });
    }
  }

  // 依赖单独处理：真源是 task_dependencies join 表，不再写 depends_on 列。
  // setDependencies 会顺带做去重、悬空引用过滤与**环路检测**（成环直接抛错）。
  let dependencyError: string | null = null;
  const hasDependencyChange = body.depends_on !== undefined;
  if (hasDependencyChange) {
    delete (updates as any).depends_on;
    const raw = body.depends_on;
    const list = Array.isArray(raw) ? raw : [];
    try {
      db.setDependencies(req.params.id, list);
    } catch (err: any) {
      dependencyError = err?.message || '依赖设置失败';
    }
  }

  // progress_log 只允许写成 JSON 字符串，防止对象直塞
  if (body.progress_log !== undefined) {
    updates.progress_log =
      typeof body.progress_log === 'string'
        ? body.progress_log
        : JSON.stringify(body.progress_log);
  }

  // 运行中的任务禁止被直接改状态（必须走 cancel）
  if (updates.status !== undefined && existing.status === 'in_progress' && updates.status !== 'in_progress') {
    return res.status(409).json({
      error: "任务正在执行中，请使用「取消」接口而非直接修改状态",
    });
  }

  if (dependencyError) {
    return res.status(409).json({ error: dependencyError });
  }

  const ok = db.updateTask(req.params.id, updates);
  // 只改依赖时 updates 会是空的（依赖不走列），此时**不算无可更新**
  if (!ok && !hasDependencyChange && body.scopes === undefined) {
    return res.status(400).json({ error: "无可更新字段" });
  }

  const updated = serializeTask(db.getTask(req.params.id)!);
  emitBoardEvent('task_updated', { task: updated, reason: 'api_patch' });
  res.json(updated);
});

api.delete("/tasks/:id", (req, res) => {
  const existing = db.getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: "任务不存在" });

  // 真正"在跑"的任务不允许直接删除，需先取消；
  // ⚠️ 但**有意停住**的（待决策等）没有执行句柄，删除是安全的 —— 否则用户会卡住删不掉
  if (existing.status === 'in_progress' && !db.isParkedTask(existing)) {
    return res.status(409).json({ error: "任务正在执行中，请先取消后再删除" });
  }
  // 待决策中的任务被删除时，也要解除挂起的授权 Promise（否则 runner 永久 suspend）
  if (db.isParkedTask(existing)) {
    cancelTaskApproval(existing.id, '任务已被删除');
  }

  db.deleteTask(req.params.id);
  emitBoardEvent('task_deleted', { taskId: req.params.id });

  res.json({ success: true });
});

// ⚠️ 2026-09-15：原先这里还有「回收独立工作树」逻辑与两个端点：
//   · `GET  /api/worktrees`（工作树概览）
//   · `POST /api/tasks/:id/cleanup-worktree`（手动回收）
// 独立工作树（`isolation: 'worktree'`）已不可用 —— 它原先只有 CLI 派发通道实现过，
// 该通道已下线⇒ `server/worktree.ts` 一并归档。
// ⚠️ `tasks.worktree_path` **列保留**（历史数据仍在，删列需迁移），只是不再有写入方。

// ---------- 任务状态流转 ----------

/** 手动把任务移入「待办」（从待决策、定时等板块） */
api.post("/tasks/:id/to-todo", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  /**
   * ⚠️ 判据必须是「**正在跑**」而不是 `status==='in_progress'`。
   *
   * 两层状态机下「待决策」= `in_progress + run_state='waiting_approval'`，
   * 它**没有执行句柄**（执行器已按设计退出）。旧写法会把"待决策"也拒掉，
   * 用户点「移回待办」看到的就是"点了没反应"（HTTP 409 被前端静默）。
   */
  if (task.status === 'in_progress' && !db.isParkedTask(task)) {
    return res.status(409).json({ error: "任务正在执行中，无法直接移回待办" });
  }
  // 移回待办意味着旧的提问不再作数，把待处理交互作废（否则会残留"待决策"）
  const canceled = db.cancelPendingInteractions(task.id);
  db.updateTask(task.id, {
    status: 'todo',
    run_state: null,
    wait_reason: null,
    scheduled_at: null,
    finished_at: null,
  });
  if (canceled > 0) console.log(`[API] 移回待办，作废 ${canceled} 条待处理交互: ${task.title}`);
  const updated = serializeTask(db.getTask(task.id)!);
  emitBoardEvent('task_updated', { task: updated, reason: 'manual_to_todo' });
  res.json(updated);
});

/** 手动取消运行中的任务（中止执行并回到待办） */
/**
 * 取消任务。
 *
 * ⚠️ 关键点：workbuddy 执行器派发出去的是**宿主侧的后台 job**，
 * 仅仅 abort 看板自己的轮询句柄并不能让它停下来 —— 宿主那边照样在跑改文件。
 * 所以这里必须再调一次官方的 `POST /api/v1/jobs/{id}/stop`。
 * 提示语按「宿主侧到底停没停」如实分档，不含糊。
 */
api.post("/tasks/:id/cancel", async (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });

  if (task.status === 'in_progress') {
    // ① 若正卡在等待授权，先解除挂起 —— 否则 runner 会一直 suspend 在那个 Promise 上
    //    （abortController.abort() 并不会 resolve 它）
    const hadApproval = cancelTaskApproval(task.id, '任务已被用户取消');

    // ② 停止看板侧跟踪
    const aborted = abortRunningTask(task.id);
    if (!aborted && !hadApproval) {
      console.warn(`[API] 取消任务 ${task.id} 时未找到执行句柄`);
    }

    // workbuddy 执行器已下线⇒ 不存在「宿主侧 job」需要停。
    // 原先这里会按 executor 分情况调 cliBridge.stopJob，现在只剩看板侧一种情形。
    const hostDetail = '看板侧已停止';

    db.cancelPendingInteractions(task.id);
    db.updateTask(task.id, {
      status: 'failed',
      error: `已被用户手动取消（${hostDetail}）`,
      finished_at: new Date().toISOString(),
    });
  } else {
    db.updateTask(task.id, {
      status: 'cancelled',
      finished_at: new Date().toISOString(),
    });
  }

  const updated = serializeTask(db.getTask(task.id)!);
  emitBoardEvent('task_updated', { task: updated, reason: 'manual_cancel' });
  res.json(updated);
});
/**
 * 提交决策：答复待处理的交互，任务带着答案回到「待办」重新排队。
 *
 * 答复走 `interactions` 表，并带**乐观锁**（version）：
 * 两个标签页同时提交时，只有一个会成功，另一个得到 409 而不是静默覆盖。
 */
/**
 * 读取任务的执行历史（每次派发一条，最新在前）。
 * 重试不会覆盖历史 —— 排查「为什么重试还是失败」时靠它。
 */
api.get("/tasks/:id/runs", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  res.json({ runs: db.listTaskRuns(task.id) });
});

/**
 * 读取任务的全部交互历史（决策 / 权限请求），按时间倒序。
 * 用于在界面上回溯「这个任务被问过什么、答过什么」。
 */
api.get("/tasks/:id/interactions", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });

  const items = db.listInteractions(task.id).map(i => {
    const payload = db.parseInteractionPayload(i);
    return {
      id: i.id,
      kind: i.kind,
      status: i.status,
      prompt: payload?.prompt ?? '',
      options: payload?.options ?? [],
      answer: db.parseInteractionAnswer(i),
      blockingScope: i.blocking_scope,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    };
  });

  res.json({
    pendingId: db.getPendingInteraction(task.id)?.id ?? null,
    interactions: items,
  });
});

/**
 * 运行中追加指令（引导当前对话）。
 *
 * ⚠️ 只对**看板自己执行的任务**有效 —— agent 是看板 spawn 的，句柄在本进程内；
 *    WB 的会话做不到（不在我们的进程里，且其提问绑定在宿主会话运行时上）。
 * 实现走 SDK 的 `Query.streamInput()`：运行中续写，**不中止、不重跑**。
 */
api.post("/tasks/:id/followup", async (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: "内容不能为空" });
  }

  const result = await streamFollowup(task.id, text);
  if (!result.ok) {
    return res.status(409).json({ ok: false, error: result.error });
  }
  res.json({ ok: true, mode: 'stream' });
});

api.post("/tasks/:id/decide", (req, res) => {  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.status !== 'in_progress' || task.run_state !== 'waiting_approval') {
    return res.status(409).json({ error: "该任务当前不处于待决策状态" });
  }

  const { answer } = req.body || {};
  if (!answer || typeof answer !== 'string' || !answer.trim()) {
    return res.status(400).json({ error: "决策内容不能为空" });
  }

  const pending = db.getPendingInteraction(task.id);
  if (!pending) {
    return res.status(409).json({ error: "该任务没有待处理的决策（可能已被处理）" });
  }

  const resolved = db.resolveInteraction(pending.id, answer.trim(), pending.version);
  if (!resolved) {
    return res.status(409).json({ error: "该决策已被处理或状态已变化，请刷新后重试" });
  }

  /**
   * ⭐ 2026-09-15 长轮询改造：把答复**就地交给挂起中的 canUseTool**，
   * agent 原地继续 —— 不再「回待办 → 重跑」。
   *
   * 旧实现（updateTask → status:'todo'）会让任务重新排队、从头上跑一遍，
   * 既浪费已完成的工具调用，也依赖 resume 续上下文。
   */
  const delivered = resolveTaskApproval(task.id, answer.trim());
  if (!delivered) {
    // 没有挂起的执行（例如重启后残留的过期待决策）⇒ 退回旧行为：回待办重跑
    console.warn(`[API] 任务 ${task.id} 没有挂起中的授权，按旧路径回退到待办`);
    db.updateTask(task.id, {
      status: 'todo',
      run_state: null,
      wait_reason: null,
      error: null,
      finished_at: null,
    });
  } else {
    // 执行器仍在跑，只是刚从"等人"回到"干活"
    db.updateTask(task.id, { run_state: 'running', wait_reason: null, error: null });
  }

  const updated = serializeTask(db.getTask(task.id)!);
  console.log(`[API] 决策已提交（interaction ${pending.id}），任务回到待办: ${task.title}`);
  emitBoardEvent('task_updated', { task: updated, reason: 'decision_submitted' });
  res.json(updated);
});

/** 手动把任务挂起为待决策（用户主动提问）。每次调用都算一条新交互。 */
api.post("/tasks/:id/request-decision", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });

  const { prompt, options } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: "决策问题不能为空" });
  }

  db.createInteraction({
    taskId: task.id,
    kind: 'manual',
    // 用户主动提问：每次都是新问题，用时间戳保证 requestId 唯一
    requestId: `manual:${task.id}:${Date.now()}`,
    payload: {
      prompt,
      options: Array.isArray(options) ? options.filter((o: unknown) => typeof o === 'string') : [],
    },
  });

  db.updateTask(task.id, {
    status: 'in_progress',
    run_state: 'waiting_approval',
  });

  const updated = serializeTask(db.getTask(task.id)!);
  emitBoardEvent('task_decision_required', { task: updated, reason: 'manual_request' });
  res.json(updated);
});

/** 重试失败的任务 */
api.post("/tasks/:id/retry", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.status !== 'failed' && task.status !== 'cancelled') {
    return res.status(409).json({ error: "只有失败或已取消的任务可以重试" });
  }

  // 重试前作废遗留交互，避免旧问题在新一轮里"复活"
  const canceled = db.cancelPendingInteractions(task.id);
  if (canceled > 0) console.log(`[API] 重试前作废 ${canceled} 条待处理交互: ${task.title}`);

  db.updateTask(task.id, {
    status: 'todo',
    run_state: null,
    wait_reason: null,
    error: null,
    result: null,
    progress_log: null,
    retry_count: task.retry_count + 1,
    started_at: null,
    finished_at: null,
  });

  const updated = serializeTask(db.getTask(task.id)!);
  emitBoardEvent('task_updated', { task: updated, reason: 'manual_retry' });
  res.json(updated);
});

/** 手动立即触发一个定时任务 */
api.post("/tasks/:id/trigger-now", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.status !== 'scheduled') {
    return res.status(409).json({ error: "该任务不在自动化定时板块" });
  }

  db.cancelPendingInteractions(task.id);
  db.updateTask(task.id, { status: 'todo', run_state: null, wait_reason: null, scheduled_at: null });
  const updated = serializeTask(db.getTask(task.id)!);
  emitBoardEvent('task_updated', { task: updated, reason: 'manual_trigger' });
  res.json(updated);
});

// ---------- 定期循环（只作用于看板自建任务） ----------

/**
 * 设置或替换一个任务的循环规则。
 *
 * 为什么不复用 `PATCH /tasks/:id`：那条路径是「字段白名单直通」，
 * 而循环规格必须**校验 + 由服务端重算首次时间**。放进白名单等于允许
 * 前端写入任意 JSON，一旦形状不对就变成「永远不触发的定时任务」，且无任何报错。
 *
 * 允许对**已结束**的循环任务重新配置（重新启用）；执行中禁止改（会与调度器打架）。
 */
api.post("/tasks/:id/repeat", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.status === 'in_progress') {
    return res.status(409).json({ error: "任务正在执行中，请先等它结束再修改循环规则" });
  }

  const body = req.body || {};
  const mode = repeat.normalizeRepeatMode(body.repeat_mode);

  // mode='none' ⇒ 关闭循环。此时保留 repeat_count（历史轮次仍要如实展示）
  if (mode === 'none') {
    db.updateTask(task.id, {
      repeat_mode: 'none',
      repeat_spec: null,
      repeat_until: null,
      repeat_limit: null,
      repeat_paused: 0,
      // 关闭循环后若任务还停在「自动化定时」列，把它挪回待办 ——
      // 否则会出现"不循环的定时任务"这种自相矛盾的状态
      ...(task.status === 'scheduled'
        ? { status: 'todo' as db.TaskStatus, scheduled_at: null }
        : {}),
    });
    const updated = serializeTask(db.getTask(task.id)!);
    emitBoardEvent('task_updated', { task: updated, reason: 'repeat_cleared' });
    return res.json(updated);
  }

  const spec = repeat.normalizeRepeatSpec(mode, body.repeat_spec);
  if (!spec) {
    return res.status(400).json({ error: "循环规则无效，请检查频率/时刻/周几等设置" });
  }

  const untilIso = (() => {
    if (!body.repeat_until) return null;
    const d = new Date(body.repeat_until);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  })();
  if (body.repeat_until && !untilIso) {
    return res.status(400).json({ error: "循环截止时间格式无效" });
  }

  const limitNum = (() => {
    const v = body.repeat_limit;
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : NaN;
  })();
  if (Number.isNaN(limitNum)) {
    return res.status(400).json({ error: "最多执行次数必须是大于 0 的整数" });
  }

  const now = new Date();
  const until = untilIso ? new Date(untilIso) : null;
  const next = repeat.computeNextRun(spec, now, until);
  if (!next) {
    return res.status(400).json({
      error: "按当前循环规则与截止时间算不出任何一次执行，请放宽截止时间或调整规则",
    });
  }

  db.updateTask(task.id, {
    repeat_mode: mode,
    repeat_spec: JSON.stringify(spec),
    repeat_until: untilIso,
    repeat_limit: limitNum,
    repeat_paused: 0,
    // 重新配置 ⇒ 排期从"现在"往后重算，而不是沿用旧时间
    scheduled_at: next.toISOString(),
    status: 'scheduled',
  });

  const updated = serializeTask(db.getTask(task.id)!);
  emitBoardEvent('task_updated', { task: updated, reason: 'repeat_configured' });
  res.json(updated);
});

/**
 * 暂停 / 恢复循环。
 *
 * 暂停：只置 `repeat_paused=1`，任务**留在「自动化定时」列**（配置不丢，可随时恢复）。
 * 恢复：必须**重算排期**到下一个未来时刻 —— 详见 `resumeRepeatSchedule` 的注释。
 */
api.post("/tasks/:id/repeat/pause", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });

  if (repeat.normalizeRepeatMode(task.repeat_mode) === 'none') {
    return res.status(409).json({ error: "该任务没有配置定期循环" });
  }

  const paused = req.body?.paused !== false; // 默认暂停

  if (paused) {
    db.updateTask(task.id, { repeat_paused: 1 });
    const updated = serializeTask(db.getTask(task.id)!);
    emitBoardEvent('task_updated', { task: updated, reason: 'repeat_paused' });
    return res.json(updated);
  }

  const nextIso = resumeRepeatSchedule(task.id);
  if (!nextIso) {
    // 算不出下一次（改了截止时间、或规则已失效）⇒ 不能假装恢复成功
    return res.status(400).json({
      error: "按当前规则算不出下一次执行时间，请检查循环规则与截止时间",
    });
  }
  const updated = serializeTask(db.getTask(task.id)!);
  emitBoardEvent('task_updated', { task: updated, reason: 'repeat_resumed' });
  res.json(updated);
});

// ---------- 调度器观测 ----------

/**
 * 调度器状态 + **真实并发占用**。
 *
 * ⚠️ 2026-09-14 修正：`globalRunning` 只数看板自己的 `in_progress` 任务，
 * 于是「WorkBuddy 里明明有任务在跑，槽位却一直显示 0/N」。
 * 现在额外计算 `occupancy`，把宿主侧正在执行的会话也算进去：
 *
 *   boardRunning —— 看板调度器占用的槽位（= globalRunning，语义不变）
 *   hostRunning  —— 宿主正在跑的会话数，**排除看板派发出去的**
 *                   （否则同一个任务在看板与宿主各记一次，数字翻倍）
 *   total        —— 二者之和，这才是「现在到底有几件事在跑」
 *
 * 注意：`hostRunning` 不参与 WSML-P 的调度判定 —— 并发上限约束的是看板
 * 自己的派发节奏；宿主侧的任务由 WorkBuddy 决定，看板只做观测。
 */
api.get("/scheduler/status", (req, res) => {
  const tasks = db.getAllTasks();
  const byStatus: Record<string, number> = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }

  // 占用口径与调度器的真判定**同一处实现**（server/hostOccupancy.ts）——
  // 否则会出现「界面显示的槽位」和「真正拿来做判定」的数不一致，最难排查
  const occupancy = getOccupancy();

  res.json({
    running: isSchedulerRunning(),
    tickIntervalMs: TICK_INTERVAL_MS,
    globalConcurrency: occupancy.limit,
    globalRunning: occupancy.boardRunning,
    runningTaskIds: getRunningTaskIds(),
    occupancy,
    byStatus,
  });
});

/** 手动触发一次调度 tick（调试用） */
api.post("/scheduler/tick", (req, res) => {
  const started = runTick();
  res.json({ started, startedCount: started.length });
});

// ---------- 宿主（WorkBuddy）只读集成 ----------

/**
 * 宿主数据快照：工作空间 / 进行中会话 / 定时自动化 / 运行记录。
 * 只读，绝不写入宿主库。
 */
api.get("/host/snapshot", (req, res) => {
  try {
    res.json(hostAdapter.getHostSnapshot());
  } catch (error: any) {
    console.error("[Host] snapshot 失败:", error);
    res.status(500).json({
      available: false,
      error: error?.message || "读取宿主数据失败",
      hostDir: "",
      workspaces: [],
      workingSessions: [],
      recentSessions: [],
      automations: [],
      latestRuns: {},
      stats: { workspaces: 0, sessionsTotal: 0, sessionsWorking: 0, automationsActive: 0 },
      fetchedAt: new Date().toISOString(),
    });
  }
});

/** 宿主连通性探针 */
api.get("/host/status", (req, res) => {
  res.json(hostAdapter.isHostAvailable());
});

/**
 * 工作空间互锁检查：某工作空间当前是否有宿主会话在执行。
 * 供前端在派发任务前提示"该目录正在被 WorkBuddy 使用"。
 */
api.get("/host/workspace-busy", (req, res) => {
  const p = String(req.query.path || "");
  if (!p) return res.status(400).json({ error: "path 为必填项" });
  res.json({ path: p, busy: hostAdapter.isWorkspaceBusy(p) });
});

/** 某会话的任务子项（宿主 tasks/<uuid>/*.json） */
api.get("/host/task-items", (req, res) => {
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
  res.json({ items: hostAdapter.getHostTaskItems(sessionId) });
});

// ============================================================
// Agent SDK 可用性 —— 本地执行器的前置条件
// （原「CLI 桥接 API」整段已下线）
// ============================================================

/**
 * Agent SDK 可用性。
 * 前端据此动态决定「本地」执行器是否可选；`?force=1` 可强制重新探测
 * （本机凭据问题若被解决，探测成功即自动恢复）。
 */
api.get("/sdk/status", async (req, res) => {
  const force = req.query.force === "1";
  // 首次访问或显式强制时执行探测，否则直接返回缓存状态（含冷却判断）
  if (force || getSdkStatus().checkedAt === null) {
    await probeSdkModels(force);
  }
  res.json(getSdkStatus());
});

// ---------- 宿主只读视图 ----------
//
// ⚠️ 原先这里还有一批「就地操作」（回复实例 / 重启实例 / 停止实例 / 读取实例对话原文 /
// 手动派发 job），它们都走 WorkBuddy 官方 REST 的 CLI 通道。该通道已下线
// ⇒ 本区段现在**全部是只读端点**。
// ⚠️ 2026-09-15：原先这里还有 `GET /api/host/op-log` —— 宿主写操作流水
// （「上次提交到底成没成」的事后可查）。CLI 派发通道下线后**已无任何写入方**，
// 端点与 `server/hostOpLog.ts` 一并移除。

// ---------- 自动化定时任务 ----------
//
// ⚠️ 用户 2026-09-14 明确要求：**取消编辑**，点击卡片只能查看属性，保证对 WorkBuddy 不写。
// 因此这里没有任何写端点；自动化详情直接来自宿主只读快照 /api/host/snapshot。
// （曾实现过定点写宿主 automations 表 + 回读校验，已按用户要求移除；改自动化请到 WorkBuddy 面板。）

/**
 * 宿主会话的「轻量对话」：待用户选择的提问 + 最近对话 + 实时活动（**只读**）。
 *
 * 用途：① 会话卡在 pending（桌面端「待确认」）时要显示**它在问什么、有哪些选项**；
 *      ② 会话在执行中时要显示**它在做什么**（实时活动流）。
 * 只读 projects/<slug>/<sessionId>.jsonl，见 server/hostTranscript.ts。
 */
api.get("/host/sessions/:id/transcript", (req, res) => {
  const includeTail = req.query.tail !== "0";
  /**
   * `mode=full`：「查看完整对话」视图用 —— 单条放宽到 8000 字，活动条数放到 500。
   * 默认（lite）：抽屉里的实时活动流，条数 30、单条 600 字，够看"在干什么"。
   */
  const full = req.query.mode === "full";
  const maxRecent = full ? 500 : 200;
  const defaultRecent = full ? 500 : 30;
  const recentLimit = Number.isFinite(Number(req.query.recent))
    ? Math.max(0, Math.min(maxRecent, Number(req.query.recent)))
    : defaultRecent;
  const data = hostTranscript.readSessionTranscript(req.params.id, {
    includeTail,
    recentLimit,
    mode: full ? "full" : "lite",
  });
  res.json(data);
});

/** 单个宿主会话详情（点开的可能不在快照的最近 N 条里） */
api.get("/host/sessions/:id", (req, res) => {
  const session = hostAdapter.getHostSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: '未找到该宿主会话' });
  res.json({ session });
});

// 启动服务器
app.use("/api", api);

// 生产模式：托管 dist 前端产物，单端口即可访问（npm run build 后访问 http://localhost:3000）
const distDir = path.resolve(__dirname, "../dist");
if (fs.existsSync(distDir)) {
  /**
   * ⚠️ 深层路由下的相对资源路径归一化（关键修复）。
   *
   * 构建产物用的是相对资源路径（vite `base: './'`，为了让预览面板在
   * `/static-html/<hash>/` 之类的子路径下也能加载）。副作用是：
   * 浏览器直接访问 / 刷新 **多段路由** 时，`./assets/index.js` 会按当前目录
   * 解析成 `/chat/assets/index.js` 或 `/a/b/assets/index.js` → 404 → 纯白页。
   *
   * 这里把「任意前缀 + /assets/<文件>」重定向到真实资源目录，
   * 既保留相对路径（预览面板可用），又让深层路由/刷新正常工作。
   */
  app.get(/^\/.*\/assets\/(.+)$/, (req, res, next) => {
    const rel = (req.params as any)[0];
    const file = path.join(distDir, "assets", rel);
    // 防目录穿越：必须落在 dist/assets 之内
    if (!path.resolve(file).startsWith(path.join(distDir, "assets"))) return next();
    if (fs.existsSync(file)) return res.sendFile(file);
    next();
  });

  app.use(express.static(distDir));
  // SPA 兜底：非 /api 的未知路径一律返回 index.html
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ 任务看板服务器已启动                  ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据库: ${path.relative(process.cwd(), db.DB_FILE_PATH) || db.DB_FILE_PATH}
║     调度器: WSML-P (tick ${TICK_INTERVAL_MS}ms)      ║
║                                            ║
╚════════════════════════════════════════════╝
  `);

  // 宿主（WorkBuddy）连通性自检：只读，失败仅告警不阻断启动
  const hostStatus = hostAdapter.isHostAvailable();
  console.log(
    hostStatus.available
      ? `[Host] 已连接 WorkBuddy: ${hostStatus.hostDir}（只读）`
      : `[Host] 未检测到 WorkBuddy 数据目录，宿主任务卡片将不可用: ${hostStatus.error ?? hostStatus.hostDir}`
  );

  // ⚠️ 2026-09-15：原先这里会 `hostOpLog.ensureHostOpLog()` 建「宿主操作流水」表。
  // 该流水已无写入方（写入点在已下线的 CLI 端点里），模块已归档 ⇒ 不再建表。

  // Node 运行时：显式告知用的是哪个 node，便于排查 spawn ENOENT 类问题
  console.log(`[Runtime] node: ${describeRuntime()}`);
  if (strippedEnv.length > 0) {
    console.log(
      `[Runtime] 已清理继承自宿主的环境变量: ${strippedEnv.join(', ')}` +
      '（CLI 会拿 SERVER__PORT 当监听端口，保留会导致子进程端口撞车）'
    );
  }

  // 服务器就绪后启动调度引擎
  startScheduler();
});
