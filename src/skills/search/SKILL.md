---
name: search
description: 处理搜索类问题并向 LLM 注入搜索上下文。
capability: search
mode: context
---

# Search

此 skill 负责 bot 运行时搜索意图的统一入口（`capability=search`）。

当前版本仅提供“搜索上下文框架”，不直接联网抓取网页内容。

- 代码入口：`src/skills/runtime/executor.ts`
- 执行模式：`context`
- 行为：将搜索查询封装为工具上下文，交由主聊天模型回答，并提示不确定性
