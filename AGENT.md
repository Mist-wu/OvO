# OvO Agent Notes

## Project goal
- TypeScript bot using NapCat OneBot v11 via forward WebSocket (NapCat as server, bot as client)

## Current status
- Base TypeScript config in place (pnpm, tsconfig, dotenv)
- WS adapter ready: connect/reconnect/heartbeat, event handler, schedule loop
- Commands: `/ping`, `/echo <text>`, `/help` (private/group)
- Notice/request/meta_event handling with logging
- Config toggles for welcome, poke reply, auto-approve group/friend requests
- WS connection verified locally with `pnpm run dev`

## Repo layout
- `package.json`, `tsconfig.json`, `.env.example`
- `src/index.ts` (entry)
- `src/config.ts` (env config)
- `src/napcat/client.ts` (WS client + actions)
- `src/napcat/handlers.ts` (event handling)
- `src/utils/schedule_tasks.ts` (periodic tasks)

## Docs
- NapCat API: `context/napcat_api.md` (when writing NapCat adapters, consult this doc proactively)

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
  - `WELCOME_ENABLED`, `WELCOME_MESSAGE`
  - `POKE_REPLY_ENABLED`, `POKE_REPLY_MESSAGE`
  - `AUTO_APPROVE_GROUP_REQUESTS`, `AUTO_APPROVE_FRIEND_REQUESTS`

## Run
1. `pnpm install`
2. copy `.env.example` -> `.env` and fill values
3. `pnpm run dev`

## Next steps
- Add richer message/action helpers
- Add queue/worker when needed
