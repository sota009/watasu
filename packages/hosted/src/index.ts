import {
  createMigratedPostgresDeliveryLedgerStore,
  type PostgresQueryClient,
  type PostgresDeliveryLedgerStore
} from "@watasu/core";
import {
  loadHostedPostgresRuntimeConfig,
  createSignedServiceIdentityHeaders,
  createSignedServiceIdentityPrincipalResolver,
  type CreateSignedServiceIdentityHeadersInput,
  type HostedProductionRequest,
  type HostedPostgresRuntimeConfig
} from "@watasu/http";
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
