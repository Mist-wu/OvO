# OvO Agent Notes

## Project goal
- TypeScript bot using NapCat OneBot v11 via forward WebSocket (NapCat as server, bot as client)

## 开发定位与原则
- 本项目定位为个人开发/个人使用，不按企业级多团队流程设计。
- 总目标是个人使用的 QQ 聊天机器人，采用 AI 辅助开发；不强求低耦合，优先保证 AI 易于开发与改动，代码模块保持清晰、简洁、易读，注释尽量少写且只在必要处补充。
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
- Reply willingness scheduler V1 ready:
  - `@bot` / `reply` / alias as must-reply
  - Group willingness scoring + priority (`must/high/normal/low`)
  - Delayed reply with cancel-on-followup (wait user to finish)
- Lightweight Action Planner V1 ready:
  - Planned actions: `no_reply` / `tool_direct` / `tool_context` / `llm`
  - Auto quote decision for group replies (uses OneBot `reply` segment)
  - Style variant routing (`default/warm/playful/concise`) + lite/full memory mode
- Lightweight Action Planner V2 ready:
  - Explicit `wait` / `complete_talk` actions
  - Strategy params (`waitMs`, `toolRetryHint`) exposed into prompt hints
  - Supports abortable wait to defer reply while user may continue speaking
- Reply Humanization V1 ready:
  - Post-process chain for punctuation cleanup + AI meta stripping
  - Optional sentence split + low-probability typo injection (configurable)
- Proactive group speaking V2 ready:
  - cold-start breaker（冷场破冰）
  - topic continuation（话题续接）
  - timed bubbling（定时冒泡）
- Chat Memory V1 ready:
  - Persistent long-term memory store (`data/chat_memory.json`)
  - Automatic fact extraction (identity/preference/relationship/meme)
  - Session summary archive for earlier turns (reduce prompt cost)
  - Prompt now includes long-term facts + archived summaries
- Chat State Engine V1 ready:
  - Runtime user/group/session state with TTL + capacity prune
  - Emotion/user-affinity/group-topic context for prompt
  - Trigger hints for willingness decision (`userAffinity/topicRelevance/groupHeat/silenceCompensation`)
- Dynamic persona adaptation V1 ready:
  - Persona style/slang/reply length adapt by state-engine signals
  - Inputs: emotion, relationship affinity, group activity
- Skills runtime V1 ready:
  - Skill Loader + Registry + Executor
  - `SKILL.md` metadata (`capability`, `mode`) wired into chat tool routing
  - Built-in capabilities: `weather` (direct), `search` (context), `time` (direct), `fx` (direct), `calc` (direct)
- Mock NapCat WebSocket test suite in `tests/mock_napcat.test.ts`
- Layered unit test suite in `tests/layered_unit.test.ts`
- Message segment builder (`text`/`at`/`reply`/`image`/`face`) + unified send helper

## Repo layout
- `package.json`, `tsconfig.json`, `.env.example`
- `src/index.ts` (entry)
- `src/config.ts` (env config)
- `src/chat/` (orchestrator, action planner, trigger, agent loop, proactive scheduler, state engine, media parser, memory, session store, safety/humanize, tool router)
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
- `src/skills/runtime/` (skill loader + registry + executor)
- `src/skills/` (runtime skills, each with `SKILL.md`)
- `src/skills/skill-creator/` (for agent to scaffold/create new skills)
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
    - `CHAT_PROACTIVE_ENABLED`, `CHAT_PROACTIVE_IDLE_MS`, `CHAT_PROACTIVE_CONTINUE_IDLE_MS`
    - `CHAT_PROACTIVE_MIN_GAP_MS`, `CHAT_PROACTIVE_BUBBLE_INTERVAL_MS`
    - `CHAT_PROACTIVE_MIN_RECENT_MESSAGES`, `CHAT_PROACTIVE_MAX_PER_TICK`
    - `CHAT_STATE_USER_TTL_MS`, `CHAT_STATE_GROUP_TTL_MS`, `CHAT_STATE_SESSION_TTL_MS`
    - `CHAT_STATE_USER_MAX`, `CHAT_STATE_GROUP_MAX`, `CHAT_STATE_SESSION_MAX`
    - `CHAT_STATE_PRUNE_INTERVAL_MS`
    - `CHAT_QUOTE_MODE` (`auto` / `on` / `off`)
    - `CHAT_STYLE_VARIANT_ENABLED`, `CHAT_STYLE_SWITCH_PROB`
    - `CHAT_HUMANIZE_ENABLED`, `CHAT_HUMANIZE_TYPO_PROB`, `CHAT_HUMANIZE_SPLIT_PROB`
    - `CHAT_PLANNER_WAIT_ENABLED`
    - `CHAT_PLANNER_WAIT_GROUP_EXTRA_MS`, `CHAT_PLANNER_WAIT_PRIVATE_EXTRA_MS`
    - `CHAT_PLANNER_WAIT_MAX_MS`
    - `CHAT_PLANNER_COMPLETE_TALK_ENABLED`
    - `CHAT_ADAPTIVE_PERSONA_ENABLED`
    - `CHAT_TRIGGER_SILENCE_COMPENSATION_ENABLED`, `CHAT_TRIGGER_SILENCE_COMPENSATION_MAX`
  - Gemini SDK:
    - `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL`, `GEMINI_TIMEOUT_MS`
    - `GEMINI_RETRIES`, `GEMINI_RETRY_DELAY_MS`, `GEMINI_CONCURRENCY`, `GEMINI_DEGRADE_ON_FAILURE`
  - Weather:
    - `WEATHER_API_KEY`, `WEATHER_TIMEOUT_MS`
    - `WEATHER_RETRIES`, `WEATHER_RETRY_DELAY_MS`, `WEATHER_CONCURRENCY`, `WEATHER_DEGRADE_ON_FAILURE`
  - Search:
    - `SEARCH_TIMEOUT_MS`, `SEARCH_MAX_RESULTS`
    - `SEARCH_RETRIES`, `SEARCH_RETRY_DELAY_MS`, `SEARCH_CONCURRENCY`, `SEARCH_DEGRADE_ON_FAILURE`
  - FX:
    - `FX_TIMEOUT_MS`
    - `FX_RETRIES`, `FX_RETRY_DELAY_MS`, `FX_CONCURRENCY`, `FX_DEGRADE_ON_FAILURE`
  - Skills:
    - Place skill metadata at `src/skills/<name>/SKILL.md`
    - `capability` is used for runtime routing (e.g. `weather`, `search`)
    - `mode` supports `direct` / `context`
  - External call governance:
    - `EXTERNAL_CIRCUIT_BREAKER_ENABLED`, `EXTERNAL_CIRCUIT_FAILURE_THRESHOLD`, `EXTERNAL_CIRCUIT_OPEN_MS`
  - Logging:
    - `LOG_LEVEL` — 全局日志最低级别（`debug` | `info` | `warn` | `error` | `silent`，默认 `info`）
      - 控制 `src/utils/logger.ts` 输出的所有日志
      - 低于此级别的日志调用会被静默丢弃
    - `NAPCAT_ACTION_LOG_ENABLED` — 是否输出 NapCat action 日志（默认 `true`）
    - `NAPCAT_ACTION_LOG_LEVEL` — NapCat action 日志级别（`debug` | `info` | `warn` | `error`，默认 `info`）
      - **独立于 `LOG_LEVEL`**：action 日志由 `logAction()` 自行按此级别过滤后，
        通过 `logger.emitRaw()` 直接输出，不受 `LOG_LEVEL` 二次截断
      - 例：`LOG_LEVEL=warn` + `NAPCAT_ACTION_LOG_LEVEL=debug` → action debug 日志**仍然会输出**

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
- Expand skill capabilities with `news` and improve skill-level source formatting
- Add planner-level memory/tool budget policy (token-aware) for long chats
- Add adaptive proactive speaking strategy using relationship + topic confidence
