# 任务看板 · Mission Control

基于 **CodeBuddy Agent SDK** 的任务调度看板，用于统一管理 WorkBuddy 中的各项任务。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/putaomeiyoupi/Workbuddy-taskboard/actions/workflows/ci.yml/badge.svg)](https://github.com/putaomeiyoupi/Workbuddy-taskboard/actions/workflows/ci.yml)

> 采用 Apache-2.0 许可，可自由使用、修改、分发（含商用）。
> 引用与致谢见文末「[引用与致谢](#引用与致谢)」。

## 核心能力

| 板块 | 说明 |
|---|---|
| **待办** | 所有新建任务默认入口，等待调度器分配执行槽位 |
| **进行中** | 正在由 Agent 执行，卡片实时显示流式日志 |
| **待决策** | 遇到需要人工确认的操作（写文件 / 危险命令）时自动挂起 |
| **自动化定时** | 设定时间到点后自动进入待办队列 |

- **新建任务时可选工作空间与模型**，并支持优先级、定时时间、前置依赖
- **拖拽调整状态**，卡片跨列移动带 FLIP 动画
- **工作空间互锁**：同一工作空间内任务串行执行，避免同目录文件冲突
- **定期循环**：任务可按周期 / 间隔重复，支持有效期与次数上限
- **混排宿主任务**：WorkBuddy 里正在执行、或正在等你确认的会话也会显示在看板上（只读）

任务由**看板自身**用 Agent SDK 在本机执行，不占用 WorkBuddy 的调度槽位；
单个工具调用可通过 `canUseTool` 精确拦截后交由你确认。

## 调度策略：WSML-P

**W**orkspace-**M**utex, **S**lot-limited, **P**riority-weighted

每 3 秒一个调度 tick，按以下顺序处理：

```
1. 提升定时任务：scheduled 且到点 → todo
2. 回收孤儿任务：running 但执行器已退出 → 回退为 todo
3. 调度候选任务：todo 按 (priority DESC, sort_order ASC, created_at ASC) 排序
   逐个检查三重约束：
     ① 依赖满足    —— depends_on 中所有任务均已 done
     ② 工作空间互锁 —— 该空间 running 数 < 其 max_concurrency
     ③ 全局资源槽   —— 全局 running 数 < global_concurrency
   全部通过 → 置为 running 并调用 SDK 执行
```

两个并发参数均可在 UI 中调整：

- **空间内并发**（`workspaces.max_concurrency`，默认 1）：同一工作空间同时运行的任务数。
  默认 1 意味着同一空间内任务串行，这是防止同目录文件互相踩踏的硬互锁。
- **全局并发**（`global_concurrency`，默认 3）：所有工作空间加起来的同时运行任务上限。

> 不同工作空间之间可并行（互不相干），同一工作空间内串行（避免冲突）。

## 状态流转

```
                     ┌─────────────┐
       新建任务 ────► │    待办     │ ◄──── 决策提交 ────┐
                     └──────┬──────┘                    │
                            │ 调度器选中                 │
                            ▼                           │
                     ┌─────────────┐                    │
                     │   进行中    │                    │
                     └──────┬──────┘                    │
                            │                           │
              ┌─────────────┼─────────────┐             │
              ▼             ▼             ▼             │
        ┌──────────┐  ┌──────────┐  ┌──────────┐        │
        │  已完成  │  │  已失败  │  │  待决策  │────────┘
        └──────────┘  └──────────┘  └──────────┘
```

- **待决策**：任务挂起等待人工输入；提交决策后回到待办重新调度
- **已失败**：可手动重试，重试会回到待办并递增 `retry_count`
- 定时任务到点后自动从「自动化定时」进入待办

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置登录（二选一）
#    A. 环境变量方式：cp .env.example .env，填入 CODEBUDDY_API_KEY
#       （Key 获取：国内站 https://copilot.tencent.com/profile/
#                  国际站 https://www.codebuddy.ai/profile/keys）
#       ⚠️ 国内站必须同时设 CODEBUDDY_INTERNET_ENVIRONMENT=internal —— 官方文档称这是
#          "最常被遗漏"的一项，漏了会鉴权失败或连到错误端点。模板里已默认给出。
#    B. 使用 CLI 已登录的凭证（应用内「设置」页可查看状态）

# 3. 启动开发服务（后端 + 前端 :5173）
npm run dev
```

Windows 上也可以直接双击 `start.cmd`：单端口同时提供前端与 API，无需单独起 Vite，
**启动就绪后会自动在浏览器里打开看板**（缺前端产物时会先自动构建一次）。
启动异常时双击 `check.cmd` 做一次自检。

`start.cmd` 的端口由 `scripts/port-preflight.mjs` 统一仲裁，**单一真源是 `config/port.txt`**
（默认 `47831`，固定不变）。端口被占用时**直接报错、不会偷偷换**；只有显式授权才允许漂移：

```bat
set KANBAN_ALLOW_PORT_SHIFT=1
start.cmd
```

不想让它自动打开浏览器就设一下环境变量：

```bat
set KANBAN_NO_BROWSER=1
start.cmd
```

### 首次使用

1. 打开浏览器访问看板（`start.cmd` 会自动打开；手动访问用控制台里打印的
   `http://localhost:<端口>`）
2. 在「设置」页确认登录状态（未登录时按提示配置 API Key 或 Token）
3. 添加一个工作空间（选择本地目录，作为任务的执行目录）
4. 新建任务，选择执行模型，即可交出去执行

## 项目结构

```
server/                 # 后端
  index.ts              # Express 入口 + 全部 API 路由
  db.ts                 # SQLite 数据层（任务 / 会话 / 工作空间）
  scheduler.ts          # WSML-P 调度器（3s tick）
  taskRunner.ts         # 执行器（Agent SDK + canUseTool 拦截）
  hostAdapter.ts        # WorkBuddy 宿主数据只读适配
  permission.ts         # 权限判定（授权放行 / 权限被拒识别）
  runtime.ts            # node 运行时定位 + 继承环境变量清理
  sdkStatus.ts          # Agent SDK 可用性探测（带冷却）
  hostTranscript.ts     # 宿主会话记录只读解析（「它在问什么」/ 实时活动流）
src/
  components/board/
    TaskBoard.tsx         # 四列看板 + FLIP 动画
    BoardColumn.tsx       # 单列（支持拖放）
    TaskCard.tsx          # 任务卡片
    TaskDetailDrawer.tsx  # 详情抽屉（实时日志 + 决策面板）
    NewTaskDialog.tsx     # 新建任务
    WorkspaceManager.tsx  # 工作空间与调度参数
    boardConfig.ts        # 板块配色与常量
  hooks/
    useTasks.ts       # 任务数据层（SSE 订阅 + CRUD）
    useWorkspaces.ts  # 工作空间与调度设置
  pages/
    BoardPage.tsx     # 看板主页
```

## 环境变量

分两类，**写入位置不同，别混**。

**① 写入项目根的 `.env`**（模板见 `.env.example`；服务端启动时读取，改完需重启）

| 变量 | 说明 |
|---|---|
| `CODEBUDDY_API_KEY` | API Key 方式登录 |
| `CODEBUDDY_AUTH_TOKEN` | Token 方式登录 |
| `CODEBUDDY_BASE_URL` | 自定义 API 端点（可选） |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | 站点选择（`internal` 国内站 / 留空国际站 / `ioa`）——**最常被漏的一项** |

**② 启动脚本用的 shell 变量**（在命令行 `set` 后运行 `start.cmd`；**不读 `.env`**）

| 变量 | 说明 |
|---|---|
| `PORT` | 后端监听端口。`npm run dev` 时默认 `3000`；`start.cmd` 会用 `config/port.txt`（默认 `47831`）**覆盖**它 |
| `KANBAN_ALLOW_PORT_SHIFT` | 设为 `1` 才允许在配置端口被占用时自动换端口。换端口后访问地址会变，**任何依赖固定端口的用法都会失效**，所以默认不允许 |
| `KANBAN_NO_BROWSER` | 设为 `1` 时 `start.cmd` 不自动打开浏览器 |
| `KANBAN_NODE` | 指定 `node.exe` 完整路径（默认自动查找：PATH → 常见安装位置 → `%USERPROFILE%\.workbuddy\binaries\node`） |

## 开发约束

- 调度器与任务执行器运行在**同一进程**，重启服务时 `running` 状态的任务会被
  自动回收为 `todo`（孤儿任务恢复机制）
- 任务执行超时 10 分钟，超时后标记为 `failed`，可手动重试
- 运行中的任务不可拖拽，需先在详情中取消
- **提交前会自动检查**：仓库启用了 `.githooks/pre-commit`（需先执行一次
  `git config core.hooksPath .githooks`）。它会拦下误提交的依赖目录、数据库、
  编译产物、截图，以及疑似密钥与本机绝对路径。检查逻辑见
  `scripts/check-commit.mjs`。

## 引用与致谢

### 设计参考

本项目的设计参考了 **[Codex Taskboard](https://github.com/Aurxs/codex-taskboard)**
（Apache-2.0，作者 [Aurxs](https://github.com/Aurxs)）。

它是一个把任务看板**注入**进 Codex 桌面客户端的项目。本项目在以下方面借鉴了它的设计思路：

| 借鉴点 | 本项目对应实现 |
|---|---|
| 「SSE 实时推送 + 周期性补偿核对」的同步策略 | `src/hooks/useTasks.ts`（每 5 秒对账，弥补重连丢事件）|
| 看板的信息架构与多列形态 | 四列：待办 / 进行中 / 待决策 / 自动化定时 |

> **说明**：以上**仅借鉴设计思路，未复制其源代码**。本项目代码为独立实现。
> 若将来复用其代码，会在 [NOTICE](NOTICE) 中补充来源与修改说明
> （Apache-2.0 §4 要求）。

### 特别感谢

- **[Aurxs/codex-taskboard](https://github.com/Aurxs/codex-taskboard)** —— 本项目的参照来源。
  其 Windows 平台文档中「不能把 macOS 上的测试通过当作 Windows 全功能验收通过」
  这一态度，也被本项目沿用为验收原则。
- **[chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)** ——
  Codex Taskboard 的上游项目（经其 NOTICE 转引）。

### 第三方资源

本项目**未使用**上述项目的任何图标或美术资源。
特别地，Codex Taskboard 的应用图标复用自 OpenAI Codex 桌面客户端、不受其
Apache-2.0 许可覆盖，本项目未使用该资源，也不主张任何 OpenAI 的背书。

### 许可

[Apache License 2.0](LICENSE) © 2026 putaomeiyoupi
