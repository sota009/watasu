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
  loadHostedRuntimeConfig,
  loadHostedPostgresRuntimeConfig,
  createSignedServiceIdentityHeaders,
  createSignedServiceIdentityPrincipalResolver,
  type CreateSignedServiceIdentityHeadersInput,
  type HostedRuntimeConfig,
  type HostedProductionRequest,
  type HostedPostgresRuntimeConfig
} from "@watasu/http";
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
  config: HostedRuntimeConfig;
  server: Server;
  close(): Promise<void>;
}

export interface HostedRetentionJobConfig {
  tenantId: string;
  retentionDays: number;
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
  const provider = env["WATASU_IDENTITY_PROVIDER"] ?? "signed_headers";
  if (provider !== "signed_headers") {
    throw new Error("WATASU_IDENTITY_PROVIDER must be signed_headers.");
  }

  const signingSecret = env["WATASU_SERVICE_IDENTITY_SIGNING_SECRET"]?.trim();
  if (signingSecret === undefined || signingSecret.length === 0) {
    throw new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET is required when WATASU_IDENTITY_PROVIDER=signed_headers.");
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

export function createHostedProductionServerFromEnv(input: {
  env: Record<string, string | undefined>;
  now: () => Date;
}): HostedProductionServerRuntime {
  const config = loadHostedRuntimeConfig(input.env);
  const identityProvider = createSignedHeaderIdentityProviderFromEnv(input);
  const ownershipRegistry = new InMemoryOwnershipChallengeRegistry({
    clock: input.now
  });
  const app = createHostedProductionBootstrapApp({
    repository: new InMemoryRequestVersionRepository(),
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
  const server = createHostedProductionServer(app);

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

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${input.name} must be a positive integer.`);
  }

  return parsed;
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
