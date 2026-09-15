/**
 * 安全的 Web Storage 读写
 * ============================================================================
 * 为什么要包一层（2026-09-16 实测定位）：
 *
 *   直接 `localStorage.getItem(...)` 在**存储受限环境**下**不是返回 null，而是抛 SecurityError**。
 *   触发条件包括：页面处于 **opaque origin**（`about:blank` / sandbox iframe / `data:` URL）、
 *   用户禁用了站点数据、或第三方存储被拦截。
 *
 *   而看板有**多处把读取写在 `useState(() => ...)` 的初始化函数里**（**渲染期同步执行**）——
 *   一旦抛错，整个 React 树被 ErrorBoundary 兜成「界面渲染出错」，**整页白屏**，
 *   而不是"主题 / 草稿 / 模型选择悄悄回落到默认值"。
 *
 *   实测复现（2026-09-16）：父页面用 `about:blank` 嵌看板 iframe ⇒
 *     `// RENDER FAULT 界面渲染出错`
 *     `Failed to read the 'localStorage' property from 'Window': Access is denied for this document.`
 *     栈指向 `Object.Cj [as useState]`
 *
 *   同类风险点还包括 **`useEffect` 内**与 **`setState` 更新函数内**的读写 —— 在那里抛错同样会
 *   冒泡到 React 并卸载整棵树。所以统一收口到本模块。
 *
 * 原则：**存储不可用时一律退化为"没有存储"** —— 功能降级（偏好不持久化、自愈计数失效），
 *       但页面必须可用、绝不白屏。
 *
 * ⚠️ 关键实现细节：`window.localStorage` 这个**属性访问本身**就可能抛（opaque origin 下），
 *    所以 try 必须包住**属性访问**，而不能只包 `getItem`。
 */

type Kind = 'local' | 'session';

/** 取存储对象；不可用（属性访问抛错）时返回 null */
function box(kind: Kind): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

/** 读字符串；不可用或抛错一律返回 null */
export function storageGet(key: string, kind: Kind = 'local'): string | null {
  try {
    return box(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 写字符串；返回是否真的写成功（配额满 / 被禁用时 false，不抛） */
export function storageSet(key: string, value: string, kind: Kind = 'local'): boolean {
  try {
    const b = box(kind);
    if (!b) return false;
    b.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** 删除；失败静默（不抛） */
export function storageRemove(key: string, kind: Kind = 'local'): void {
  try {
    box(kind)?.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/** 读 JSON；缺失或解析失败一律返回 fallback（不抛） */
export function storageGetJSON<T>(key: string, fallback: T, kind: Kind = 'local'): T {
  const raw = storageGet(key, kind);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写 JSON；返回是否成功（不抛） */
export function storageSetJSON(key: string, value: unknown, kind: Kind = 'local'): boolean {
  try {
    return storageSet(key, JSON.stringify(value), kind);
  } catch {
    return false;   // 含循环引用等序列化失败
  }
}
