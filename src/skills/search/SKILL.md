---
name: search
description: 处理搜索类问题并向 LLM 注入搜索上下文。
capability: search
mode: context
---

# Search

此 skill 负责 bot 运行时搜索意图的统一入口（`capability=search`）。

当前版本会实时抓取网页搜索结果（DuckDuckGo + Wikipedia），并将结果注入聊天上下文。

- 代码入口：`src/skills/runtime/executor.ts`
- 底层检索：`src/utils/search_web.ts`
- 执行模式：`context`
- 行为：将检索摘要、来源、链接封装为工具上下文，交由主聊天模型回答
