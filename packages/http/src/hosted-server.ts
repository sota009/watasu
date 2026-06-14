import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type {
  HostedProductionApp,
  HostedProductionRequest
} from "./hosted-production.js";

export type { HostedProductionRequest } from "./hosted-production.js";

export interface HostedRuntimeConfig {
  host: string;
  port: number;
}

export function loadHostedRuntimeConfig(env: Record<string, string | undefined>): HostedRuntimeConfig {
  const host = env["WATASU_HOSTED_HOST"] ?? "0.0.0.0";
  const port = Number.parseInt(env["WATASU_HOSTED_PORT"] ?? "8787", 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("WATASU_HOSTED_PORT must be an integer between 1 and 65535.");
  }

  return {
    host,
    port
  };
}

export function createHostedProductionServer(app: HostedProductionApp): Server {
  return createServer(async (request, response) => {
    const handled = await app.handle(buildHostedProductionRequest({
      method: request.method ?? "GET",
      url: request.url,
      headers: normalizeHeaders(request.headers),
      body: await readRequestBody(request)
    }));

    response.writeHead(handled.status, handled.headers);
    response.end(handled.body);
  });
}

export function buildHostedProductionRequest(input: {
  method: string;
  url: string | undefined;
  headers: HostedProductionRequest["headers"];
  body: string;
}): HostedProductionRequest {
  return {
    method: input.method,
    path: input.url === undefined ? "/" : new URL(input.url, "http://localhost").pathname,
    headers: input.headers,
    body: input.body
  };
}

function normalizeHeaders(headers: IncomingHttpHeaders): HostedProductionRequest["headers"] {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : value
    ])
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}
