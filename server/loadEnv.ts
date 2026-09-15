/**
 * `.env` 加载（**必须在任何会读环境变量的模块之前 import**）
 * ============================================================
 * ⚠️ 背景（2026-09-15 实测发现）：README「快速开始」一直写着
 *   「在 `.env` 中设置 CODEBUDDY_API_KEY」，**但服务此前从未加载过 `.env`**
 *   （全库搜不到 dotenv / loadEnvFile）⇒ 照文档做的用户会「配了却没生效」，
 *   而且完全没有提示，极难排查。
 *
 * 补上这一步后，文档路径才真正可用：把凭证写进项目根的 `.env` 即可，
 * 不必改 `start.cmd`、也不必每次重启后在设置页重填。
 *
 * 为什么单独一个模块：ESM 的 import 是**提升**的，写成「index.ts 顶部的一行语句」
 * 会晚于其它模块的顶层代码（例如 `runtime.ts` 在模块加载时就解析 NODE_EXE）。
 * 要保证最先执行，只能是**第一个 import 的模块**。
 *
 * 用法行的 `.env`（项目根）：
 *   CODEBUDDY_API_KEY=sk-xxxxxxxx
 *   CODEBUDDY_INTERNET_ENVIRONMENT=internal
 *
 * ⚠️ `CODEBUDDY_INTERNET_ENVIRONMENT` 不能漏 —— 官方文档明确写着
 *   「未设置或设错会导致鉴权失败或连到错误的服务端点」，且国内站必须为 `internal`。
 *
 * ⚠️ 安全：`.env` 必须留在 `.gitignore` 里，绝不能提交。
 *    本模块只用 Node 内置的 `process.loadEnvFile`，不引入 dotenv 依赖。
 */
import { existsSync } from 'fs';
import path from 'path';

/** 默认读 <cwd>/.env；文件不存在属于正常情况（多数用户走设置页那条路） */
const envPath = path.resolve(process.cwd(), '.env');

if (existsSync(envPath)) {
  try {
    // Node ≥ 20.6 内置；已存在的同名变量**不会**被覆盖（沿用 Node 的语义）
    process.loadEnvFile(envPath);
    console.log(`[Env] 已加载 ${envPath}`);
    // 只报告「是否配置」，绝不打印值
    for (const k of ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_INTERNET_ENVIRONMENT', 'CODEBUDDY_BASE_URL']) {
      if (process.env[k]) console.log(`[Env]   ${k} = <已设置>`);
    }
    if (!process.env.CODEBUDDY_INTERNET_ENVIRONMENT) {
      console.warn('[Env]   ⚠️ 未设置 CODEBUDDY_INTERNET_ENVIRONMENT：国内站需为 internal，否则可能鉴权失败或连错端点');
    }
  } catch (err) {
    console.warn(`[Env] 加载 ${envPath} 失败（已忽略）：${(err as Error)?.message || err}`);
  }
}
