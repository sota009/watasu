#!/usr/bin/env node
import {
  createHostedProductionServerFromEnv,
  formatHostedCommandError,
  type HostedProductionServerRuntime
} from "./index.js";

let runtime: HostedProductionServerRuntime;
try {
  runtime = createHostedProductionServerFromEnv({
    env: process.env,
    now: () => new Date()
  });
} catch (error) {
  console.error(formatHostedCommandError(error, "Hosted production startup failed."));
  process.exit(1);
}

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
