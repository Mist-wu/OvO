import { NapcatClient } from "./napcat/client";

const client = new NapcatClient();
client.connect();

const shutdown = async () => {
  console.log("接收到退出信号，安全关闭中...");
  await client.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
