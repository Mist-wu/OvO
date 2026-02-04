import { config } from "../config";
import type { NapcatClient } from "../napcat/client";

export function scheduleLoop(client: NapcatClient): NodeJS.Timeout {
  const intervalMs = config.scheduler.intervalMs;

  return setInterval(() => {
    client.sendAction("get_status").catch((error) => {
      console.warn("[schedule] get_status 失败:", error);
    });
  }, intervalMs);
}
