---
name: time
description: 查询指定时区或城市当前时间并直接回复。
capability: time
mode: direct
---

# Time

此 skill 用于时间查询能力（`capability=time`）。

- 代码入口：`src/skills/runtime/executor.ts`
- 底层实现：`src/utils/time.ts`
- 返回：目标时区当前时间（格式化为中文可读）
