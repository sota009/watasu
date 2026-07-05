import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Readable } from "node:stream";
import type {
  HostedProductionApp,
  HostedProductionRequest,
  HostedProductionResponse
} from "./hosted-production.js";

export type { HostedProductionRequest } from "./hosted-production.js";

export interface HostedRuntimeConfig {
  host: string;
  port: number;
}

export interface HostedPublicBaseUrlConfig {
  publicBaseUrl: string;
}

export interface HostedProductionServerOptions {
  beforeAppRequest?: HostedProductionServerBeforeAppRequest | undefined;
  maxRequestBodyBytes?: number | undefined;
}

export type HostedProductionServerBeforeAppRequest = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean> | boolean;

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
  const portSource = env["PORT"] ?? env["WATASU_HOSTED_PORT"] ?? "8787";
  const port = parseStrictPositiveInteger(portSource);

  if (port === undefined || port > 65535) {
    throw new Error("PORT or WATASU_HOSTED_PORT must be an integer between 1 and 65535.");
  }

  return {
    host,
    port
  };
}

export function loadHostedPublicBaseUrlConfig(
  env: Record<string, string | undefined>
): HostedPublicBaseUrlConfig {
  const publicBaseUrl = env["WATASU_PUBLIC_BASE_URL"]?.trim();
  if (publicBaseUrl === undefined || publicBaseUrl.length === 0) {
    throw new Error("WATASU_PUBLIC_BASE_URL is required.");
  }

  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    throw new Error("WATASU_PUBLIC_BASE_URL must be a valid absolute URL.");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("WATASU_PUBLIC_BASE_URL must not include username or password.");
  }

  if (url.protocol !== "https:" && !isLocalLoopbackHost(url.hostname)) {
    throw new Error("WATASU_PUBLIC_BASE_URL must use https outside local loopback.");
  }

  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("WATASU_PUBLIC_BASE_URL must not include a path, query, or fragment.");
  }

  return {
    publicBaseUrl: url.origin
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
  const ssl = parsePostgresSsl(env["WATASU_POSTGRES_SSL"]);
  if (ssl === "disable" && !isLocalLoopbackOrRenderPrivatePostgresUrl(databaseUrl)) {
    throw new Error("WATASU_POSTGRES_SSL=disable is allowed only for local loopback or Render private database URLs.");
  }

  return {
    mode: "postgres",
    databaseUrl,
    poolMax: parsePositiveIntegerEnv(env["WATASU_POSTGRES_POOL_MAX"], {
      defaultValue: 10,
      name: "WATASU_POSTGRES_POOL_MAX"
    }),
    ssl,
    runMigrations: parseBooleanEnv(env["WATASU_POSTGRES_RUN_MIGRATIONS"], {
      defaultValue: true,
      name: "WATASU_POSTGRES_RUN_MIGRATIONS"
    })
  };
}

const defaultMaxRequestBodyBytes = 256 * 1024;

export class HostedRequestBodyTooLargeError extends Error {
  readonly code = "request_body_too_large";

  constructor() {
    super("Request body exceeds the hosted production limit.");
  }
}

export function createHostedProductionServer(
  app: HostedProductionApp,
  options: HostedProductionServerOptions = {}
): Server {
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? defaultMaxRequestBodyBytes;

  return createServer(async (request, response) => {
    try {
      if (options.beforeAppRequest !== undefined) {
        for (const [name, value] of Object.entries(hostedSecurityHeaders)) {
          response.setHeader(name, value);
        }

        const prehandled = await options.beforeAppRequest(request, response);
        if (prehandled) {
          return;
        }
      }

      if (isContentLengthOverLimit(request.headers, maxRequestBodyBytes)) {
        request.resume();
        const handled = requestBodyTooLargeResponse();
        response.writeHead(handled.status, withHostedSecurityHeaders(handled.headers));
        response.end(handled.body);
        return;
      }

      let body: string;
      try {
        body = await readHostedRequestBody(request, {
          maxBytes: maxRequestBodyBytes
        });
      } catch (error) {
        if (isHostedRequestBodyTooLargeError(error)) {
          const handled = requestBodyTooLargeResponse();
          response.writeHead(handled.status, withHostedSecurityHeaders(handled.headers));
          response.end(handled.body);
          return;
        }

        throw error;
      }

      const handled = await app.handle(buildHostedProductionRequest({
        method: request.method ?? "GET",
        url: request.url,
        headers: normalizeHeaders(request.headers),
        body
      }));

      response.writeHead(handled.status, withHostedSecurityHeaders(handled.headers));
      response.end(handled.body);
    } catch {
      if (response.headersSent) {
        response.end();
        return;
      }

      const handled = internalServerErrorResponse();
      response.writeHead(handled.status, withHostedSecurityHeaders(handled.headers));
      response.end(handled.body);
    }
  });
}

const hostedSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
} as const;

export function withHostedSecurityHeaders(
  headers: HostedProductionResponse["headers"]
): HostedProductionResponse["headers"] {
  // Security headers are forced globally, EXCEPT a route may declare its own
  // Content-Security-Policy (e.g. the consent page needs a nonce'd inline
  // script; the default `default-src 'none'` would break it). A route CSP wins.
  const routeCsp = headers["content-security-policy"];
  return {
    ...headers,
    ...hostedSecurityHeaders,
    ...(routeCsp === undefined ? {} : { "content-security-policy": routeCsp })
  };
}

function parsePositiveIntegerEnv(value: string | undefined, input: {
  defaultValue: number;
  name: string;
}): number {
  if (value === undefined) {
    return input.defaultValue;
  }

  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${input.name} must be a positive integer.`);
  }

  return parsed;
}

function parseStrictPositiveInteger(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function isLocalLoopbackOrRenderPrivatePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isLocalLoopbackHost(url.hostname) || isRenderPrivatePostgresHost(url.hostname);
  } catch {
    return false;
  }
}

function isLocalLoopbackHost(hostname: string): boolean {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  return normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1";
}

function isRenderPrivatePostgresHost(hostname: string): boolean {
  return /^dpg-[a-z0-9-]+$/.test(hostname);
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

export async function readHostedRequestBody(input: Readable, options: {
  maxBytes?: number | undefined;
} = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? defaultMaxRequestBodyBytes;
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new HostedRequestBodyTooLargeError();
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export function isContentLengthOverLimit(
  headers: IncomingHttpHeaders,
  maxRequestBodyBytes: number
): boolean {
  const rawContentLength = headers["content-length"];
  if (rawContentLength === undefined || Array.isArray(rawContentLength)) {
    return false;
  }

  const contentLength = parseStrictPositiveInteger(rawContentLength);
  return contentLength !== undefined && contentLength > maxRequestBodyBytes;
}

function isHostedRequestBodyTooLargeError(error: unknown): error is HostedRequestBodyTooLargeError {
  return error instanceof HostedRequestBodyTooLargeError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "request_body_too_large");
}

function requestBodyTooLargeResponse(): HostedProductionResponse {
  return {
    status: 413,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify({
      ok: false,
      status: "rejected",
      error: {
        code: "request_body_too_large",
        message: "Request body exceeds the hosted production limit."
      }
    })}\n`
  };
}

function internalServerErrorResponse(): HostedProductionResponse {
  return {
    status: 500,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify({
      ok: false,
      status: "rejected",
      error: {
        code: "internal_server_error",
        message: "Hosted production request failed."
      }
    })}\n`
  };
}
