# OvO

TypeScript 个人机器人项目，基于 NapCat OneBot v11 正向 WebSocket。

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
- 代码入口：
  - `src/llm/gemini.ts`
  - `createGeminiSdkClient()`：创建 Gemini SDK 客户端
  - `getGeminiModel()`：读取默认模型名
  - `getGeminiSetupSummary()`：输出当前 Gemini 配置摘要

## 天气配置
- `/天气 <城市>` 使用 `api2.wer.plus`。
- 在 `.env` 中设置：
  - `WEATHER_API_KEY`
  - `WEATHER_TIMEOUT_MS`（可选，默认 8000ms）

## 常用命令
- root 指令（仅 `ROOT_USER_ID`）：
  - `/ping` 健康检查
  - `/echo <text>` 回显文本
  - `/help` 查看完整命令列表（root + user）
  - `/status` 查看运行状态（连接、队列、pending）
  - `/config` 查看当前配置摘要
  - `/group on|off [group_id]` 群开关
  - `/cooldown [ms]` 查看/设置冷却
- user 指令（所有用户可用）：
  - `/帮助` 查看 user 指令列表
  - `/天气 <城市>` 查询天气

## 测试与构建
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
