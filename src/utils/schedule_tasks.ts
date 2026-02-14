import { logger } from "./logger";
import { chatAgentLoop } from "../chat";
import { config } from "../config";
import type { NapcatClient } from "../napcat/client";

export function scheduleLoop(client: NapcatClient): NodeJS.Timeout {
  const intervalMs = config.scheduler.intervalMs;
  let proactiveRunning = false;

  return setInterval(() => {
    client.getStatus().catch((error) => {
      logger.warn("[schedule] get_status 失败:", error);
    });

    if (proactiveRunning) return;
    proactiveRunning = true;
    chatAgentLoop
      .runSchedulerTick(client)
      .catch((error) => {
        logger.warn("[schedule] proactive tick 失败:", error);
      })
      .finally(() => {
        proactiveRunning = false;
      });
  }, intervalMs);
}
