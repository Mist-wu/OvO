export type TextSegment = {
  type: "text";
  data: { text: string };
};

export type AtSegment = {
  type: "at";
  data: { qq: number | "all" };
};

export type ReplySegment = {
  type: "reply";
  data: { id: number | string };
};

export type ImageSegment = {
  type: "image";
  data: { file: string };
};

export type FaceSegment = {
  type: "face";
  data: { id: number };
};

export type MessageSegment =
  | TextSegment
  | AtSegment
  | ReplySegment
  | ImageSegment
  | FaceSegment
  | {
      type: string;
      data: Record<string, unknown>;
    };

export type MessageInput = string | MessageSegment | MessageSegment[];

export function text(value: string): TextSegment {
  return { type: "text", data: { text: value } };
}

export function at(qq: number | "all"): AtSegment {
  return { type: "at", data: { qq } };
}

export function reply(id: number | string): ReplySegment {
  return { type: "reply", data: { id } };
}

export function image(file: string): ImageSegment {
  return { type: "image", data: { file } };
}

export function face(id: number): FaceSegment {
  return { type: "face", data: { id } };
}

export function normalizeMessage(input: MessageInput): MessageSegment[] {
  if (typeof input === "string") {
    return [text(input)];
  }
  if (Array.isArray(input)) {
    return input.slice();
  }
  return [input];
}

export function buildMessage(...parts: MessageInput[]): MessageSegment[] {
  const result: MessageSegment[] = [];
  for (const part of parts) {
    result.push(...normalizeMessage(part));
  }
  return result;
}
