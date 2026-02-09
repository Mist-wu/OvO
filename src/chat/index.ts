import { createChatOrchestrator } from "./orchestrator";

export { createChatOrchestrator };
export type { ChatEvent, ChatReply } from "./types";

export const chatOrchestrator = createChatOrchestrator();
