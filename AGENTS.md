# OvO Agent Notes

## Project goal
- TypeScript bot using NapCat OneBot v11 via forward WebSocket (NapCat as server, bot as client)

## 开发定位与原则
- 本项目定位为个人开发/个人使用，不按企业级多团队流程设计。
- 总目标是个人使用的 QQ 聊天机器人，采用 AI 辅助开发；不强求低耦合，优先保证 AI 易于开发与改动，代码模块保持清晰、简洁、易读，注释尽量少写且只在必要处补充。
- 安全策略保持简明：优先使用环境变量管理 token、最小必要权限、失败可追踪日志；不引入复杂 RBAC、审计平台或重型密钥体系。
- 测试策略保持简明：优先覆盖核心链路与高风险改动，默认使用 `pnpm run test:mock`，必要时补 `pnpm run build`；避免过度复杂的测试基础设施。
- 新增功能时先保证可运行与可维护，再逐步增强，不为了“完整性”提前引入复杂机制。

## Docs
- NapCat API: `context/napcat_api.md` (when writing NapCat adapters, consult this doc proactively)
- Gemini API codegen instructions: `https://github.com/googleapis/js-genai/blob/main/codegen_instructions.md`

## NapCat 适配策略
- 以 OneBot v11 事件/动作字段为准，优先查 `context/napcat_api.md`，不要凭记忆硬编码字段名。

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