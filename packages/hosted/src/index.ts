import {
  buildOwnershipVerification,
  createMetadataLedgerReader,
  InMemoryOwnershipChallengeRegistry,
  InMemoryRequestVersionRepository,
  createMigratedPostgresDeliveryLedgerStore,
  runHostedMetadataLedgerRetentionJob,
  type PostgresQueryClient,
  type PostgresDeliveryLedgerStore
} from "@watasu/core";
import {
  createHostedProductionBootstrapApp,
  createHostedProductionServer,
  loadHostedPublicBaseUrlConfig,
  loadHostedRuntimeConfig,
  loadHostedPostgresRuntimeConfig,
  createSignedServiceIdentityHeaders,
  createSignedServiceIdentityPrincipalResolver,
  type CreateSignedServiceIdentityHeadersInput,
  type HostedPublicBaseUrlConfig,
  type HostedRuntimeConfig,
  type HostedProductionRequest,
  type HostedPostgresRuntimeConfig
} from "@watasu/http";
import {
  buildMcpProtectedResourceMetadata,
  createHostedMcpHttpEntrypoint
} from "@watasu/mcp";
import type { Server } from "node:http";
import type {
  Pool,
  PoolConfig,
  QueryResult
} from "pg";

export interface PostgresPoolLike {
  query(text: string, values: readonly unknown[]): Promise<Pick<QueryResult, "rows">>;
  end(): Promise<void>;
}

export interface HostedPostgresLedgerRuntime {
  store: PostgresDeliveryLedgerStore;
  close(): Promise<void>;
}

export interface HostedProductionServerRuntime {
  config: HostedRuntimeConfig & HostedPublicBaseUrlConfig;
  server: Server;
  close(): Promise<void>;
}

export interface HostedRetentionJobConfig {
  tenantId: string;
  retentionDays: number;
}

export interface HostedRetentionArgs {
  dryRun: boolean;
}

export type HostedIdentityProviderConfig =
  | {
      provider: "signed_headers";
      signingSecret: string;
      maxSkewSeconds: number;
    };

export interface HostedSignedHeaderIdentityProvider {
  resolvePrincipal(request: HostedProductionRequest): ReturnType<
    ReturnType<typeof createSignedServiceIdentityPrincipalResolver>
  >;
  createHeaders(input: Omit<CreateSignedServiceIdentityHeadersInput, "signingSecret">): Record<string, string>;
}

export function loadHostedIdentityProviderConfig(
  env: Record<string, string | undefined>
): HostedIdentityProviderConfig {
  const minimumHostedSigningSecretBytes = 32;
  const provider = env["WATASU_IDENTITY_PROVIDER"] ?? "signed_headers";
  if (provider !== "signed_headers") {
    throw new Error("WATASU_IDENTITY_PROVIDER must be signed_headers.");
  }

  const signingSecret = env["WATASU_SERVICE_IDENTITY_SIGNING_SECRET"]?.trim();
  if (signingSecret === undefined || signingSecret.length === 0) {
    throw new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET is required when WATASU_IDENTITY_PROVIDER=signed_headers.");
  }
  if (Buffer.byteLength(signingSecret, "utf8") < minimumHostedSigningSecretBytes) {
    throw new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET must be at least 32 bytes.");
  }

  return {
    provider,
    signingSecret,
    maxSkewSeconds: parsePositiveIntegerEnv(env["WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS"], {
      defaultValue: 60,
      name: "WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS"
    })
  };
}

export function createSignedHeaderIdentityProviderFromEnv(input: {
  env: Record<string, string | undefined>;
  now: () => Date;
}): HostedSignedHeaderIdentityProvider {
  const config = loadHostedIdentityProviderConfig(input.env);
  const resolvePrincipal = createSignedServiceIdentityPrincipalResolver({
    signingSecret: config.signingSecret,
    now: input.now,
    maxSkewSeconds: config.maxSkewSeconds
  });

  return {
    resolvePrincipal,
    createHeaders(headerInput) {
      return createSignedServiceIdentityHeaders({
        ...headerInput,
        signingSecret: config.signingSecret
      });
    }
  };
}

export function loadHostedRetentionJobConfig(env: Record<string, string | undefined>): HostedRetentionJobConfig {
  const tenantId = env["WATASU_RETENTION_TENANT_ID"]?.trim();
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error("WATASU_RETENTION_TENANT_ID is required.");
  }

  return {
    tenantId,
    retentionDays: parsePositiveIntegerEnv(env["WATASU_METADATA_RETENTION_DAYS"], {
      defaultValue: 90,
      name: "WATASU_METADATA_RETENTION_DAYS"
    })
  };
}

export function parseHostedRetentionArgs(argv: readonly string[]): HostedRetentionArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    return {
      dryRun: false
    };
  }

  if (args.length === 1 && args[0] === "--dry-run") {
    return {
      dryRun: true
    };
  }

  throw new Error("Usage: pnpm --filter @watasu/hosted retention -- [--dry-run]");
}

export function formatHostedCommandError(error: unknown, fallbackMessage: string): string {
  if (!(error instanceof Error)) {
    return fallbackMessage;
  }

  const message = error.message;
  if (containsSecretLikeHostedCommandFragment(message)) {
    return fallbackMessage;
  }

  if (/^(PORT|WATASU_[A-Z0-9_]+|Usage: )/.test(message)) {
    return message;
  }

  return fallbackMessage;
}

function containsSecretLikeHostedCommandFragment(message: string): boolean {
  return /postgres(?:ql)?:\/\//i.test(message) ||
    /\b(?:password|token|secret|private[_ -]?key)\b/i.test(message);
}

export function createHostedProductionServerFromEnv(input: {
  env: Record<string, string | undefined>;
  now: () => Date;
}): HostedProductionServerRuntime {
  const config = {
    ...loadHostedRuntimeConfig(input.env),
    ...loadHostedPublicBaseUrlConfig(input.env)
  };
  const identityProviderConfig = loadHostedIdentityProviderConfig(input.env);
  const identityProvider = createSignedHeaderIdentityProviderFromEnv(input);
  const ownershipRegistry = new InMemoryOwnershipChallengeRegistry({
    clock: input.now
  });
  const app = createHostedProductionBootstrapApp({
    repository: new InMemoryRequestVersionRepository(),
    publicBaseUrl: config.publicBaseUrl,
    deliverySigningSecret: identityProviderConfig.signingSecret,
    ledgerReader: createMetadataLedgerReader({
      rows: [],
      requestTenants: {},
      auditLog: {
        write() {}
      }
    }),
    resolvePrincipal: identityProvider.resolvePrincipal,
    resolveOwnershipVerification({ principal }) {
      return buildOwnershipVerification({
        tenant_id: principal.tenant_id,
        registry: ownershipRegistry
      });
    }
  });
  const mcpEntrypoint = createHostedMcpHttpEntrypoint({
    endpointPath: "/mcp",
    allowedOrigins: [config.publicBaseUrl],
    resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
    scopes: ["watasu:publish", "watasu:ledger:read"]
  });
  const mcpProtectedResourceMetadata = buildMcpProtectedResourceMetadata({
    resource: `${config.publicBaseUrl}/mcp`,
    authorizationServers: [config.publicBaseUrl],
    scopesSupported: ["watasu:publish", "watasu:ledger:read"]
  });
  const server = createHostedProductionServer(app, {
    async beforeAppRequest(request, response) {
      const path = request.url === undefined ? "/" : new URL(request.url, config.publicBaseUrl).pathname;
      if (path === "/.well-known/oauth-protected-resource") {
        if (request.method !== "GET") {
          response.writeHead(405, {
            allow: "GET",
            "content-type": "application/json; charset=utf-8"
          });
          response.end(`${JSON.stringify({
            ok: false,
            error: {
              code: "method_not_allowed",
              message: "MCP protected-resource metadata supports GET."
            }
          })}\n`);
          return true;
        }

        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(`${JSON.stringify(mcpProtectedResourceMetadata)}\n`);
        return true;
      }

      if (path !== "/mcp") {
        return false;
      }

      await mcpEntrypoint(request, response);
      return true;
    }
  });

  return {
    config,
    server,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }

          reject(error);
        });
      });
    }
  };
}

export function createPostgresPoolQueryClient(pool: {
  query(text: string, values: readonly unknown[]): Promise<Pick<QueryResult, "rows">>;
}): PostgresQueryClient {
  return {
    async query(text, values) {
      return pool.query(text, values);
    }
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

export function createNodePostgresPoolConfig(input: Extract<
  HostedPostgresRuntimeConfig,
  { mode: "postgres" }
>): PoolConfig {
  return {
    connectionString: input.databaseUrl,
    max: input.poolMax,
    ssl: input.ssl === "require"
      ? {
          rejectUnauthorized: true
        }
      : false
  };
}

export async function createNodePostgresPool(input: Extract<
  HostedPostgresRuntimeConfig,
  { mode: "postgres" }
>): Promise<Pool> {
  const pg = await import("pg");
  return new pg.Pool(createNodePostgresPoolConfig(input));
}

export async function createHostedPostgresLedgerStoreFromEnv(input: {
  env: Record<string, string | undefined>;
  tenantId: string;
  createPool?: ((config: PoolConfig) => PostgresPoolLike) | undefined;
}): Promise<HostedPostgresLedgerRuntime> {
  const config = loadHostedPostgresRuntimeConfig(input.env);
  if (config.mode !== "postgres") {
    throw new Error("WATASU_METADATA_LEDGER_STORE must be postgres for hosted Postgres runtime wiring.");
  }

  const pool = input.createPool === undefined
    ? await createNodePostgresPool(config)
    : input.createPool(createNodePostgresPoolConfig(config));
  const queryClient = createPostgresPoolQueryClient(pool);
  const store = await createMigratedPostgresDeliveryLedgerStore({
    tenantId: input.tenantId,
    queryClient,
    runMigration: config.runMigrations
  });

  return {
    store,
    async close() {
      await pool.end();
    }
  };
}

export async function runHostedPostgresRetentionJobFromEnv(input: {
  dryRun?: boolean | undefined;
  env: Record<string, string | undefined>;
  now: () => Date;
  createPool?: ((config: PoolConfig) => PostgresPoolLike) | undefined;
}) {
  const config = loadHostedRetentionJobConfig(input.env);
  const runtime = await createHostedPostgresLedgerStoreFromEnv({
    env: input.env,
    tenantId: config.tenantId,
    createPool: input.createPool
  });

  try {
    return await runHostedMetadataLedgerRetentionJob({
      dryRun: input.dryRun,
      serviceIdentity: {
        tenant_id: config.tenantId,
        roles: ["auditor"]
      },
      now: input.now(),
      retentionDays: config.retentionDays,
      store: runtime.store
    });
  } finally {
    await runtime.close();
  }
}
