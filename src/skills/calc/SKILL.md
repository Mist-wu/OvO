---
name: calc
description: 执行简单数学表达式计算并返回结果。
capability: calc
mode: direct
---

# Calc

此 skill 用于简单算术计算（`capability=calc`）。

- 代码入口：`src/skills/runtime/executor.ts`
- 底层实现：`src/utils/calc.ts`
- 支持：`+ - * / ()` 与小数
