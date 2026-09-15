/**
 * WorkBuddy 模型目录（与桌面端同源）
 * ============================================================================
 * 用户反馈（2026-09-14）：
 *   「新建任务的时候，可选择的模型与 WorkBuddy 中看到的不一样。」
 *
 * 为什么不一样：看板此前有两条来源，都**不是**桌面端用的那份：
 *   1. Agent SDK 的 `getAvailableModels()` —— SDK 视角的列表；
 *   2. `hostAdapter.getObservedModels()` —— 历史会话里"见过"的模型 id
 *      （就只有 8 个零散值，还会带上早已不用的旧模型）。
 *
 * 桌面端下拉的真源是**产品配置** `acc-product-config-v3.json` 的 `models[]`：
 *   - 宿主启动时会把它 spill 到 `%TEMP%\workbuddy-product-spill-*\/acc-product-config-v3.json`
 *     （路径同时通过环境变量 `ACC_PRODUCT_CONFIG_PATH` 暴露）；
 *   - 用户在 `~/.workbuddy/models.json` 里加的自定义模型，会被合并进这份清单，
 *     id 前缀为 `custom-local:`。
 * 本模块只读上面这份配置，并把结果对齐成看板要的 `{modelId, name, description}`。
 *
 * ⚠️ **绝不写任何 WorkBuddy 文件**；`models.json` 里含自定义模型的 apiKey，
 * 本模块只取 id/name/vendor/描述等非敏感字段，密钥不出本模块。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CatalogModel {
  modelId: string;
  name: string;
  description?: string;
  vendor?: string;
  tags?: string[];
  /** 产品配置里的默认模型 */
  isDefault?: boolean;
  /** 是否算「常用」（界面默认只列这些，避免 50+ 项淹没人） */
  recommended?: boolean;
}

export interface ModelCatalog {
  models: CatalogModel[];
  defaultModel: string | null;
  /** 这份清单来自哪里：workbuddy-config / models-json / observed / fallback */
  source: string;
  /** 命中的配置文件路径（排障用） */
  configPath?: string;
  /** 被过滤掉的数量与原因（排障用，界面不展示） */
  filtered?: { disabled: number; imageGen: number };
  reason?: string;
}

/**
 * 标记「常用」模型 —— 用于把 50+ 个候选项收敛成一眼能选完的短清单。
 *
 * 判据（都来自产品配置自身，不靠硬编码模型名）：
 *   - 默认档位与三档基础模型（快速/均衡/极致）
 *   - `tags` 含 `craft`（宿主标记为适合 Agent 对话）
 *   - 用户自定义模型（`custom`）
 *   - `observed` 里传进来的「本机真实跑过」的模型 id
 *
 * 用户反馈就是「模型选择列表里有特别多的选项」，所以默认只展示常用，
 * 需要时再一键展开全部。
 */
export function markRecommended(models: CatalogModel[], observed: string[] = []): CatalogModel[] {
  const observedSet = new Set(observed);
  return models.map(m => ({
    ...m,
    recommended:
      m.isDefault === true ||
      TIER_IDS.includes(m.modelId) ||
      m.tags?.includes('craft') === true ||
      m.tags?.includes('custom') === true ||
      observedSet.has(m.modelId),
  }));
}

/** 结果缓存（配置很少变，按文件 mtime 失效） */
let cache: { at: number; mtimeMs: number; file: string; catalog: ModelCatalog } | null = null;
const CACHE_TTL_MS = 60_000;

/** 图像生成类标签：不能作为「执行任务的模型」 */
const IMAGE_TAGS = new Set(['text-to-image', 'image-to-image']);

/** 候选配置文件（按优先级尝试） */
function candidateConfigFiles(): string[] {
  const out: string[] = [];
  const fromEnv = process.env.ACC_PRODUCT_CONFIG_PATH;
  if (fromEnv) out.push(fromEnv);

  // spill 目录：取最近修改的那个（同机上可能残留很多个历史 spill）
  const tmp = os.tmpdir();
  try {
    const entries = fs
      .readdirSync(tmp, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('workbuddy-product-spill-'))
      .map(e => path.join(tmp, e.name, 'acc-product-config-v3.json'))
      .filter(f => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
    out.push(...entries);
  } catch {
    // tmp 读不到就算了
  }
  return out;
}

/** 归一化一条产品配置里的模型条目 */
function toCatalogModel(raw: any): CatalogModel {
  const id = String(raw?.id ?? '');
  return {
    modelId: id,
    name: String(raw?.name ?? id),
    description:
      (typeof raw?.descriptionZh === 'string' && raw.descriptionZh) ||
      (typeof raw?.descriptionEn === 'string' && raw.descriptionEn) ||
      undefined,
    vendor: raw?.vendor ? String(raw.vendor) : undefined,
    tags: Array.isArray(raw?.tags) ? raw.tags.map((t: unknown) => String(t)) : undefined,
    isDefault: raw?.isDefault === true,
  };
}

/**
 * 排序：默认模型 → 三个档位（快速/均衡/极致）→ craft 标签 → 其余。
 * 让最常用的排在最前面，和桌面端点开就看到常用模型的手感一致。
 */
const TIER_IDS = ['fast-model', 'balanced-model', 'deep-model'];

function sortModels(models: CatalogModel[]): CatalogModel[] {
  const rank = (m: CatalogModel): number => {
    if (m.isDefault) return 0;
    const tierIdx = TIER_IDS.indexOf(m.modelId);
    if (tierIdx >= 0) return 1 + tierIdx;
    if (m.tags?.includes('craft')) return 10;
    if (m.tags?.includes('custom')) return 20;
    return 30;
  };
  return [...models].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

/** 解析产品配置 → 目录 */
function readFromProductConfig(file: string): ModelCatalog | null {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const list = Array.isArray(raw?.models) ? raw.models : null;
  if (!list || list.length === 0) return null;

  let disabled = 0;
  let imageGen = 0;
  const models: CatalogModel[] = [];
  for (const item of list) {
    const m = toCatalogModel(item);
    if (!m.modelId) continue;
    // 用户禁用的模型不该出现在可选列表里
    if (item?.disabled === true) {
      disabled += 1;
      continue;
    }
    // 图像生成模型不是"执行任务的模型"，选它跑任务必然失败
    if (m.tags?.some(t => IMAGE_TAGS.has(t))) {
      imageGen += 1;
      continue;
    }
    models.push(m);
  }
  if (models.length === 0) return null;

  const sorted = sortModels(models);
  return {
    models: sorted,
    defaultModel: sorted.find(m => m.isDefault)?.modelId ?? sorted[0]?.modelId ?? null,
    source: 'workbuddy-config',
    configPath: file,
    filtered: { disabled, imageGen },
  };
}

/** 兜底：直接读 ~/.workbuddy/models.json（自定义模型；可能是裸数组或 {models:[]}） */
function readFromModelsJson(): ModelCatalog | null {
  const file = path.join(
    process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy'),
    'models.json'
  );
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : null;
    if (!list || list.length === 0) return null;
    const models = list
      .map((item: any) => toCatalogModel({ ...item, modelId: item?.id ?? item?.modelId }))
      .filter((m: CatalogModel) => m.modelId);
    if (models.length === 0) return null;
    return {
      models,
      defaultModel: models[0].modelId,
      source: 'models-json',
      configPath: file,
    };
  } catch {
    return null;
  }
}

/**
 * 取 WorkBuddy 的模型目录（带 mtime 失效的缓存）。
 *
 * 返回 `null` 表示连兜底源都读不到 —— 调用方应回落到 SDK / 宿主观测。
 */
export function getWorkbuddyModelCatalog(): ModelCatalog | null {
  for (const file of candidateConfigFiles()) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue; // 不存在，试下一个
    }
    if (
      cache &&
      cache.file === file &&
      cache.mtimeMs === mtimeMs &&
      Date.now() - cache.at < CACHE_TTL_MS
    ) {
      return cache.catalog;
    }
    const catalog = readFromProductConfig(file);
    if (catalog) {
      cache = { at: Date.now(), mtimeMs, file, catalog };
      return catalog;
    }
  }

  const fromJson = readFromModelsJson();
  if (fromJson) return fromJson;
  return null;
}

/** 供排障：这台机器上找到了哪些候选配置 */
export function describeCatalogSources(): Array<{ file: string; exists: boolean; mtimeMs?: number }> {
  return candidateConfigFiles().map(f => {
    try {
      return { file: f, exists: true, mtimeMs: fs.statSync(f).mtimeMs };
    } catch {
      return { file: f, exists: false };
    }
  });
}
