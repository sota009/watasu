#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";

const smokeSigningSecret = "hosted-start-smoke-signing-secret-with-enough-entropy";
const smokeMcpBearerToken = "hosted-start-smoke-mcp-bearer-token-with-enough-entropy";
const checkedUrl = "http://127.0.0.1:1/health";
const workspaceRoot = new URL("../", import.meta.url);

const build = spawnSync("pnpm", ["--silent", "typecheck"], {
  cwd: workspaceRoot,
  encoding: "utf8"
});
if (build.status !== 0) {
  process.stderr.write("Hosted start smoke build failed.\n");
  process.exit(1);
}

const { createHostedProductionServerFromEnv } = await import("../packages/hosted/dist/index.js");

const runtime = createHostedProductionServerFromEnv({
  env: {
    PORT: "1",
    WATASU_IDENTITY_PROVIDER: "signed_headers",
    WATASU_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    WATASU_SERVICE_IDENTITY_SIGNING_SECRET: smokeSigningSecret,
    WATASU_MCP_BEARER_TOKEN: smokeMcpBearerToken,
    WATASU_METADATA_LEDGER_STORE: "disabled"
  },
  now: () => new Date()
});

try {
  const request = Readable.from([]);
  request.headers = {
    accept: "application/json"
  };
  request.method = "GET";
  request.url = "/health";
  const response = captureHostedResponse();

  runtime.server.emit("request", request, response.response);
  const handled = await response.ended;
  if (handled.status !== 200) {
    throw new Error(`Hosted health returned ${handled.status}.`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked_command: "pnpm --filter @watasu/hosted start",
    checked_mode: "closed_server_health_request",
    checked_url: checkedUrl,
    checked_status: handled.status,
    checked_body: JSON.parse(handled.body)
  })}\n`);
} finally {
  if (runtime.server.listening) {
    await runtime.close();
  }
}

function captureHostedResponse() {
  let status = 0;
  const headers = {};
  let resolveEnded = () => {};
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });

  return {
    ended,
    response: {
      setHeader(name, value) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      },
      writeHead(nextStatus, nextHeaders = {}) {
        status = nextStatus;
        for (const [name, value] of Object.entries(nextHeaders)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
        }
      },
      end(body = "") {
        resolveEnded({
          body,
          headers,
          status
        });
      }
    }
  };
}
