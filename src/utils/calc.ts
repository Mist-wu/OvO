type Operator = "+" | "-" | "*" | "/";

type Token =
  | { type: "number"; value: number }
  | { type: "operator"; value: Operator }
  | { type: "left_paren" }
  | { type: "right_paren" };

const OP_PRECEDENCE: Record<Operator, number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
};

function normalizeExpression(input: string): string {
  return input.replace(/\s+/g, "").replace(/，/g, ",").replace(/[×xX]/g, "*").replace(/÷/g, "/");
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];

    if (isDigit(char) || char === ".") {
      let end = index + 1;
      while (end < expression.length && (isDigit(expression[end]) || expression[end] === ".")) {
        end += 1;
      }
      const raw = expression.slice(index, end);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error("无效数字");
      }
      tokens.push({ type: "number", value });
      index = end;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "left_paren" });
      index += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ type: "right_paren" });
      index += 1;
      continue;
    }

    throw new Error("表达式包含不支持字符");
  }
  return tokens;
}

function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const operators: Token[] = [];

  for (const token of tokens) {
    if (token.type === "number") {
      output.push(token);
      continue;
    }

    if (token.type === "operator") {
      while (operators.length > 0) {
        const top = operators[operators.length - 1];
        if (top.type !== "operator") break;
        if (OP_PRECEDENCE[top.value] < OP_PRECEDENCE[token.value]) break;
        output.push(operators.pop() as Token);
      }
      operators.push(token);
      continue;
    }

    if (token.type === "left_paren") {
      operators.push(token);
      continue;
    }

    while (operators.length > 0 && operators[operators.length - 1].type !== "left_paren") {
      output.push(operators.pop() as Token);
    }
    if (operators.length <= 0 || operators[operators.length - 1].type !== "left_paren") {
      throw new Error("括号不匹配");
    }
    operators.pop();
  }

  while (operators.length > 0) {
    const top = operators.pop() as Token;
    if (top.type === "left_paren" || top.type === "right_paren") {
      throw new Error("括号不匹配");
    }
    output.push(top);
  }

  return output;
}

function evalRpn(tokens: Token[]): number {
  const stack: number[] = [];
  for (const token of tokens) {
    if (token.type === "number") {
      stack.push(token.value);
      continue;
    }
    if (token.type !== "operator") {
      throw new Error("表达式结构错误");
    }
    if (stack.length < 2) {
      throw new Error("表达式不完整");
    }
    const right = stack.pop() as number;
    const left = stack.pop() as number;
    let result = 0;
    if (token.value === "+") result = left + right;
    if (token.value === "-") result = left - right;
    if (token.value === "*") result = left * right;
    if (token.value === "/") {
      if (right === 0) throw new Error("除数不能为0");
      result = left / right;
    }
    stack.push(result);
  }

  if (stack.length !== 1) {
    throw new Error("表达式结构错误");
  }
  return stack[0];
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  if (Math.abs(value) >= 1_000_000_000) {
    return value.toExponential(6);
  }
  const fixed = Number(value.toFixed(8));
  return String(fixed);
}

export function evaluateExpression(expression: string): number {
  const normalized = normalizeExpression(expression);
  if (!normalized) {
    throw new Error("表达式为空");
  }
  if (normalized.length > 120) {
    throw new Error("表达式过长");
  }
  if (!/^[\d+\-*/().]+$/.test(normalized)) {
    throw new Error("表达式包含不支持字符");
  }
  const tokens = tokenize(normalized);
  const rpn = toRpn(tokens);
  return evalRpn(rpn);
}

export function calculateExpressionSummary(expression: string): string {
  try {
    const result = evaluateExpression(expression);
    return `计算结果：${expression.trim()} = ${formatNumber(result)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "计算失败";
    return `计算失败：${message}`;
  }
}
