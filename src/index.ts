import { logger } from "./utils/logger";
import { NapcatClient } from "./napcat/client";

const client = new NapcatClient();
client.connect();

const onShutdown = async () => {
  logger.info("接收到退出信号，安全关闭中...");
  await client.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => void onShutdown());
process.on("SIGTERM", () => void onShutdown());
