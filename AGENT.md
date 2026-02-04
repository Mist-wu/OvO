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
