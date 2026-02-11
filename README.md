<p align="center">
    <h1 align="center">✨ OvO ✨</h1>
    <p align="center">
        TypeScript 个人Chat Agent项目，基于 NapCat OneBot v11 正向 WebSocket。
    </p>
</p>

## 快速开始
1. `pnpm install`
2. 复制 `.env.example` 为 `.env` 并填写连接配置
3. `pnpm run dev`

## Gemini SDK（直连）
- 仅保留 Gemini，使用 `@google/genai` 直接连接，不再保留多模型集成层。
- 在 `.env` 中设置：
  - `GEMINI_API_KEY`
  - `GEMINI_MODEL`
  - `GEMINI_BASE_URL`
  - `GEMINI_TIMEOUT_MS`
  - `GEMINI_RETRIES`, `GEMINI_RETRY_DELAY_MS`, `GEMINI_CONCURRENCY`
  - `GEMINI_DEGRADE_ON_FAILURE`
- 代码入口：
  - `src/llm/gemini.ts`
  - `createGeminiSdkClient()`：创建 Gemini SDK 客户端
  - `getGeminiModel()`：读取默认模型名
  - `getGeminiSetupSummary()`：输出当前 Gemini 配置摘要
  - `askGemini()`：统一外部调用治理（超时/重试/并发）后的 Gemini 问答

## 天气配置
- `/天气 <城市>` 使用 `api2.wer.plus`。
- 在 `.env` 中设置：
  - `WEATHER_API_KEY`
  - `WEATHER_TIMEOUT_MS`（可选，默认 8000ms）
  - `WEATHER_RETRIES`, `WEATHER_RETRY_DELAY_MS`, `WEATHER_CONCURRENCY`
  - `WEATHER_DEGRADE_ON_FAILURE`

## 搜索与汇率配置
- 实时搜索：
  - `SEARCH_TIMEOUT_MS`
  - `SEARCH_MAX_RESULTS`
  - `SEARCH_RETRIES`, `SEARCH_RETRY_DELAY_MS`, `SEARCH_CONCURRENCY`
  - `SEARCH_DEGRADE_ON_FAILURE`
- 汇率：
  - `FX_TIMEOUT_MS`
  - `FX_RETRIES`, `FX_RETRY_DELAY_MS`, `FX_CONCURRENCY`
  - `FX_DEGRADE_ON_FAILURE`

## Skills（聊天工具能力）
- 聊天工具调用改为技能架构：`Skill Loader + Skill Registry + Skill Executor`。
- Skill 根目录：`src/skills/<skill-name>/SKILL.md`
- 运行时入口：
  - `src/skills/runtime/loader.ts`
  - `src/skills/runtime/registry.ts`
  - `src/skills/runtime/executor.ts`
- 当前内置能力：
  - `weather`（`capability=weather`, direct）
  - `search`（`capability=search`, context，实时网页检索）
  - `time`（`capability=time`, direct）
  - `fx`（`capability=fx`, direct）
  - `calc`（`capability=calc`, direct）

## NapCat 动作队列治理
- 动作发送链路支持可配置并发、队列上限、每秒限流与指数退避重试。
- 在 `.env` 中设置：
  - `NAPCAT_ACTION_QUEUE_CONCURRENCY`, `NAPCAT_ACTION_QUEUE_MAX_SIZE`
  - `NAPCAT_ACTION_RATE_LIMIT_PER_SECOND`
  - `NAPCAT_ACTION_RETRY_ATTEMPTS`, `NAPCAT_ACTION_RETRY_BASE_DELAY_MS`, `NAPCAT_ACTION_RETRY_MAX_DELAY_MS`

## 外部调用治理
- 统一治理入口：`src/utils/external_call.ts`
- 支持超时、重试、并发门控、熔断与降级回退
- 熔断配置：`EXTERNAL_CIRCUIT_BREAKER_ENABLED`、`EXTERNAL_CIRCUIT_FAILURE_THRESHOLD`、`EXTERNAL_CIRCUIT_OPEN_MS`

## 常用命令
- root 指令（仅 `ROOT_USER_ID`）：
  - `/ping` 健康检查
  - `/echo <text>` 回显文本
  - `/问 <问题>` 使用 Gemini 问答
  - `/help` 查看完整命令列表（root + user）
  - `/status` 查看运行状态（连接、队列、pending）
  - `/config` 查看当前配置摘要（含 `skillsLoaded`）
  - `/group on|off [group_id]` 群开关
  - `/cooldown [ms]` 查看/设置冷却
- user 指令（所有用户可用）：
  - `/帮助` 查看 user 指令列表
  - `/天气 <城市>` 查询天气

## 聊天模式（Phase A + B-1）
- 非指令消息会进入聊天编排器：
  - 私聊：默认回复
  - 群聊：仅在 `@bot` / `reply` / 点名别名 时回复（默认别名：`小o`,`ovo`）
- Agent Loop（统一循环内核）：
  - `src/chat/agent_loop.ts` 统一收敛聊天回复、工具执行、主动发言调度
  - 会话级状态机支持 `pending -> queued -> running -> follow-up`
  - 新消息可覆盖延迟中的旧回复，并在运行中对旧 turn 执行过期丢弃（打断/跟进）
- 会话记忆为内存滑动窗口（重启后清空），用于保持短期上下文连续性
- Long-term Memory V1：
  - 持久化用户长期记忆（身份/偏好/关系/梗等）到 `CHAT_MEMORY_PATH`
  - 自动从较早对话切分并归档摘要，供后续提示词引用，降低上下文成本
- 支持图片/GIF 输入解析（`image` 消息段），会作为多模态输入交给 Gemini
- 聊天工具路由（当前）：
  - 天气问题优先走天气工具并直接返回结果
  - 搜索类问题走实时网页检索（DuckDuckGo + Wikipedia）并注入来源上下文
  - 时间/汇率/计算类问题优先走 direct skill 直接返回
- 回复调度（V1）：
  - `@bot` / `reply` / 别名：必回
  - 普通群消息：基于意愿评分择机回复
  - 非必回场景：短延迟并可被同会话新消息覆盖（等用户说完）
- 主动发言（V2）：
  - 冷场破冰：群聊冷却后自动轻量开场
  - 话题续接：有主话题时按空窗续接
  - 定时冒泡：长期无 bot 发言时主动存在感冒泡
- Gemini失败或返回空文本时，回退到 `CHAT_EMPTY_REPLY_FALLBACK`

### 聊天配置
- `CHAT_ENABLED`：聊天总开关
- `CHAT_MAX_SESSION_MESSAGES`：单会话保留消息数（user+assistant）
- `CHAT_GROUP_TRIGGER_MODE`：群触发模式（当前支持 `passive`）
- `CHAT_BOT_ALIASES`：点名触发别名（逗号分隔）
- `CHAT_EMPTY_REPLY_FALLBACK`：聊天降级文案
- `CHAT_MAX_REPLY_CHARS`：最大回复长度
- `CHAT_PERSONA_NAME`：单一全局人格名称
- `CHAT_MEDIA_ENABLED`：是否启用图片/GIF解析
- `CHAT_MEDIA_MAX_IMAGES`：单次最多解析图片数量
- `CHAT_MEDIA_FETCH_TIMEOUT_MS`：远程图片抓取超时
- `CHAT_MEDIA_MAX_BYTES`：单图最大字节数
- `CHAT_MEMORY_ENABLED`：是否启用长期记忆与摘要归档
- `CHAT_MEMORY_PATH`：长期记忆存储文件路径
- `CHAT_MEMORY_MAX_FACTS_PER_USER`：每个用户最多保留事实条数
- `CHAT_MEMORY_CONTEXT_FACT_COUNT`：提示词中注入的长期事实条数
- `CHAT_SUMMARY_CONTEXT_COUNT`：提示词中注入的归档摘要条数
- `CHAT_SUMMARY_ARCHIVE_TRIGGER_MESSAGES`：触发归档的最小会话消息数
- `CHAT_SUMMARY_ARCHIVE_CHUNK_MESSAGES`：每次归档切出的旧消息条数
- `CHAT_SUMMARY_ARCHIVE_KEEP_LATEST_MESSAGES`：归档后保留在短期上下文中的最新消息数
- `CHAT_SUMMARY_ARCHIVE_MAX_PER_SESSION`：每个会话最多保留的归档摘要数
- `CHAT_PROACTIVE_ENABLED`：主动发言开关
- `CHAT_PROACTIVE_IDLE_MS`：冷场破冰触发空窗
- `CHAT_PROACTIVE_CONTINUE_IDLE_MS`：话题续接最小空窗
- `CHAT_PROACTIVE_MIN_GAP_MS`：同群两次主动发言最小间隔
- `CHAT_PROACTIVE_BUBBLE_INTERVAL_MS`：定时冒泡间隔
- `CHAT_PROACTIVE_MIN_RECENT_MESSAGES`：话题续接最小近窗消息数
- `CHAT_PROACTIVE_MAX_PER_TICK`：每个调度周期最多主动发言群数

## 测试与构建
- `pnpm run test:unit`：分层单测（事件守卫、命令访问级别、外部调用治理）
- `pnpm run test:mock`：核心链路回归（连接、命令、中间件、动作重试/超时）
- `pnpm run build`：TypeScript 类型检查与构建

## 开发原则（简明）
- 面向个人开发与个人使用，优先可运行、易维护。
- 安全策略保持简单：环境变量管理 token、最小权限、错误可追踪。
- 测试保持精简：覆盖核心流程与高风险改动，避免复杂测试基础设施。

## 权限模型
- 在 `.env` 中设置唯一 `ROOT_USER_ID=<qq号>`。
- root 用户可执行全部命令；普通用户仅可执行 user 指令集。
- 普通用户执行 root 指令时返回“无权限”。
- 连接成功后会自动私聊 root 用户：`Bot成功启动`。
- 已移除管理员变更能力，不再支持运行时增删管理员。
