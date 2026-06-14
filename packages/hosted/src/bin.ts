#!/usr/bin/env node
import { createHostedProductionServerFromEnv } from "./index.js";

const runtime = createHostedProductionServerFromEnv({
  env: process.env,
  now: () => new Date()
});

runtime.server.listen(runtime.config.port, runtime.config.host, () => {
  process.stdout.write(`watasu hosted production listening on ${runtime.config.host}:${runtime.config.port}\n`);
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  process.stdout.write(`watasu hosted production received ${signal}; shutting down\n`);
  await runtime.close();
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => {
    process.exit(0);
  });
});

process.once("SIGINT", () => {
  void shutdown("SIGINT").then(() => {
    process.exit(0);
  });
});
