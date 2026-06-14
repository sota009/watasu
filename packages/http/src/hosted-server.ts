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

export type HostedPostgresRuntimeConfig =
  | {
      mode: "disabled";
    }
  | {
      mode: "postgres";
      databaseUrl: string;
      poolMax: number;
      ssl: "disable" | "require";
      runMigrations: boolean;
    };

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

export function loadHostedPostgresRuntimeConfig(
  env: Record<string, string | undefined>
): HostedPostgresRuntimeConfig {
  const store = env["WATASU_METADATA_LEDGER_STORE"] ?? "disabled";
  if (store === "disabled") {
    return {
      mode: "disabled"
    };
  }

  if (store !== "postgres") {
    throw new Error("WATASU_METADATA_LEDGER_STORE must be disabled or postgres.");
  }

  const databaseUrl = env["WATASU_POSTGRES_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("WATASU_POSTGRES_URL is required when WATASU_METADATA_LEDGER_STORE=postgres.");
  }

  return {
    mode: "postgres",
    databaseUrl,
    poolMax: parsePositiveIntegerEnv(env["WATASU_POSTGRES_POOL_MAX"], {
      defaultValue: 10,
      name: "WATASU_POSTGRES_POOL_MAX"
    }),
    ssl: parsePostgresSsl(env["WATASU_POSTGRES_SSL"]),
    runMigrations: parseBooleanEnv(env["WATASU_POSTGRES_RUN_MIGRATIONS"], {
      defaultValue: true,
      name: "WATASU_POSTGRES_RUN_MIGRATIONS"
    })
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

function parsePositiveIntegerEnv(value: string | undefined, input: {
  defaultValue: number;
  name: string;
}): number {
  if (value === undefined) {
    return input.defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${input.name} must be a positive integer.`);
  }

  return parsed;
}

function parseBooleanEnv(value: string | undefined, input: {
  defaultValue: boolean;
  name: string;
}): boolean {
  if (value === undefined) {
    return input.defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${input.name} must be true or false.`);
}

function parsePostgresSsl(value: string | undefined): "disable" | "require" {
  if (value === undefined || value === "require") {
    return "require";
  }

  if (value === "disable") {
    return "disable";
  }

  throw new Error("WATASU_POSTGRES_SSL must be require or disable.");
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
