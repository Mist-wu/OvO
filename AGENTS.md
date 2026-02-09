# OvO Agent Notes

## Project goal
- TypeScript bot using NapCat OneBot v11 via forward WebSocket (NapCat as server, bot as client)

## 开发定位与原则
- 本项目定位为个人开发/个人使用，不按企业级多团队流程设计。
- 安全策略保持简明：优先使用环境变量管理 token、最小必要权限、失败可追踪日志；不引入复杂 RBAC、审计平台或重型密钥体系。
- 测试策略保持简明：优先覆盖核心链路与高风险改动，默认使用 `pnpm run test:mock`，必要时补 `pnpm run build`；避免过度复杂的测试基础设施。
- 新增功能时先保证可运行与可维护，再逐步增强，不为了“完整性”提前引入复杂机制。

## Current status
- Base TypeScript config in place (pnpm, tsconfig, dotenv)
- WS adapter ready: connect/reconnect/heartbeat, event handler, schedule loop
- Action governance ready: queue concurrency/size, rate-limit, retry backoff, runtime metrics
- Commands (root): `/ping`, `/echo <text>`, `/问 <问题>`, `/help`, `/status`, `/config`, `/group`, `/cooldown`
- Commands (user): `/帮助`, `/天气 <城市>`
- Command architecture refactored: registry + middleware (permission/group-enabled/cooldown)
- Notice/request/meta_event handling with logging
- Config toggles for welcome, poke reply, auto-approve group/friend requests
- Permission model: single root user (`ROOT_USER_ID`) + user command set for all users
- Persistent runtime config store ready (`groupEnabled`, `cooldownMs`) with versioned JSON file
- On startup, bot auto-sends "Bot成功启动" to `ROOT_USER_ID`
- WS connection verified locally with `pnpm run dev`
- Action tracking: echo-based pending map, timeout handling, error formatting
- Optional action logging level + enable switch; no-wait action send supported
- External call governance ready: timeout/retry/concurrency/circuit-breaker/fallback
- Chat Phase A ready:
  - Non-command messages routed to chat orchestrator
  - Private chat replies by default
  - Group chat passive trigger only (`@bot` / `reply` / alias)
  - In-memory sliding-window session context + single global persona
- Chat Phase B-1 ready:
  - Image/GIF message segment parsing (`image`)
  - Multimodal Gemini call path (`text + inline images`)
  - Supports `data:image/...;base64,...`, `base64://...`, URL/local-path image sources
- Chat Memory V1 ready:
  - Persistent long-term memory store (`data/chat_memory.json`)
  - Automatic fact extraction (identity/preference/relationship/meme)
  - Session summary archive for earlier turns (reduce prompt cost)
  - Prompt now includes long-term facts + archived summaries
- Mock NapCat WebSocket test suite in `tests/mock_napcat.test.ts`
- Layered unit test suite in `tests/layered_unit.test.ts`
- Message segment builder (`text`/`at`/`reply`/`image`/`face`) + unified send helper

## Repo layout
- `package.json`, `tsconfig.json`, `.env.example`
- `src/index.ts` (entry)
- `src/config.ts` (env config)
- `src/chat/` (chat orchestrator, trigger, media parser, session store, safety)
- `src/napcat/client.ts` (WS client + actions)
- `src/napcat/handlers.ts` (event handling)
- `src/napcat/commands/` (registry, middleware, root/user definitions)
- `src/napcat/message.ts` (message segment helpers)
- `src/napcat/actions.ts` (typed action builders)
- `src/llm/gemini.ts` (Gemini SDK 直连)
- `src/llm/index.ts` (LLM exports)
- `src/chat/memory.ts` (long-term memory manager + archive strategy)
- `src/storage/config_store.ts` (persistent runtime config)
- `src/storage/chat_memory_store.ts` (persistent chat memory store)
- `src/utils/external_call.ts` (unified external call governance)
- `src/utils/weather.ts` (weather adapter + formatter)
- `src/utils/schedule_tasks.ts` (periodic tasks)
- `tests/layered_unit.test.ts` (layered unit tests)
- `tests/mock_napcat.test.ts` (mock NapCat WS test)

## Docs
- NapCat API: `context/napcat_api.md` (when writing NapCat adapters, consult this doc proactively)
- Gemini API codegen instructions: `https://github.com/googleapis/js-genai/blob/main/codegen_instructions.md`

## NapCat 适配策略
- 以 OneBot v11 事件/动作字段为准，优先查 `context/napcat_api.md`，不要凭记忆硬编码字段名。
- 事件分发以 `post_type` 为入口，分别处理 `message` / `notice` / `request` / `meta_event`，对字段缺失保持容错。
- 消息发送统一走 action 封装（如 `send_msg`），传入 `message` 段数组；私聊/群聊根据 `user_id`/`group_id` 自动选择。
- 需要回复/引用时使用 `reply` 消息段或 `message_id`（依文档），不要拼装原始文本。
- 所有 action 返回需检查 `status`/`retcode` 并记录失败原因，必要时重试或降级为日志提示。

## Config (NapCat WS forward)
- Enable OneBot v11 WebSocket server in NapCat
- Set host/port and (optional) access token
- Bot config options:
  - `NAPCAT_WS_URL=ws://<host>:<port>[/?access_token=...]`
  - `NAPCAT_TOKEN` or `NAPCAT_ACCESS_TOKEN` (sends `Authorization: Bearer ...`)
  - `NAPCAT_ACTION_TIMEOUT_MS`
  - `NAPCAT_ACTION_LOG_ENABLED`
  - `NAPCAT_ACTION_LOG_LEVEL` (`error` / `warn` / `info` / `debug`)
  - `NAPCAT_ACTION_QUEUE_CONCURRENCY`, `NAPCAT_ACTION_QUEUE_MAX_SIZE`
  - `NAPCAT_ACTION_RATE_LIMIT_PER_SECOND`
  - `NAPCAT_ACTION_RETRY_ATTEMPTS`, `NAPCAT_ACTION_RETRY_BASE_DELAY_MS`, `NAPCAT_ACTION_RETRY_MAX_DELAY_MS`
  - `ROOT_USER_ID` (唯一 root 用户 QQ 号)
  - `WELCOME_ENABLED`, `WELCOME_MESSAGE`
  - `POKE_REPLY_ENABLED`, `POKE_REPLY_MESSAGE`
  - `AUTO_APPROVE_GROUP_REQUESTS`, `AUTO_APPROVE_FRIEND_REQUESTS`
  - Chat:
    - `CHAT_ENABLED`, `CHAT_MAX_SESSION_MESSAGES`
    - `CHAT_GROUP_TRIGGER_MODE` (current: `passive`)
    - `CHAT_BOT_ALIASES` (default: `小o,ovo`)
    - `CHAT_EMPTY_REPLY_FALLBACK`, `CHAT_MAX_REPLY_CHARS`, `CHAT_PERSONA_NAME`
    - `CHAT_MEDIA_ENABLED`, `CHAT_MEDIA_MAX_IMAGES`
    - `CHAT_MEDIA_FETCH_TIMEOUT_MS`, `CHAT_MEDIA_MAX_BYTES`
    - `CHAT_MEMORY_ENABLED`, `CHAT_MEMORY_PATH`
    - `CHAT_MEMORY_MAX_FACTS_PER_USER`, `CHAT_MEMORY_CONTEXT_FACT_COUNT`
    - `CHAT_SUMMARY_CONTEXT_COUNT`
    - `CHAT_SUMMARY_ARCHIVE_TRIGGER_MESSAGES`
    - `CHAT_SUMMARY_ARCHIVE_CHUNK_MESSAGES`
    - `CHAT_SUMMARY_ARCHIVE_KEEP_LATEST_MESSAGES`
    - `CHAT_SUMMARY_ARCHIVE_MAX_PER_SESSION`
  - Gemini SDK:
    - `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL`, `GEMINI_TIMEOUT_MS`
    - `GEMINI_RETRIES`, `GEMINI_RETRY_DELAY_MS`, `GEMINI_CONCURRENCY`, `GEMINI_DEGRADE_ON_FAILURE`
  - Weather:
    - `WEATHER_API_KEY`, `WEATHER_TIMEOUT_MS`
    - `WEATHER_RETRIES`, `WEATHER_RETRY_DELAY_MS`, `WEATHER_CONCURRENCY`, `WEATHER_DEGRADE_ON_FAILURE`
  - External call governance:
    - `EXTERNAL_CIRCUIT_BREAKER_ENABLED`, `EXTERNAL_CIRCUIT_FAILURE_THRESHOLD`, `EXTERNAL_CIRCUIT_OPEN_MS`

## Run
1. `pnpm install`
2. copy `.env.example` -> `.env` and fill values
3. `pnpm run dev`
4. `pnpm run test:unit` (layered unit test)
5. `pnpm run test:mock` (mock NapCat WS test)
6. `pnpm run build` (type-check/build)

## Workflow
1. Build the feature or change.
2. Add or update tests covering the change.
3. Run the relevant tests (`pnpm run test:mock` when touching NapCat WS logic).

## Next steps
- Add reply willingness/priority scheduler (must-reply when mentioned, optional reply otherwise)
- Add proactive group speaking strategy (cold-start breaker + timed bubbling + topic continuation)
- Add richer tool routing (search/news/weather/time/calc) with source-aware formatting
