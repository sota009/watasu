import {
  createMigratedPostgresDeliveryLedgerStore,
  type PostgresQueryClient,
  type PostgresDeliveryLedgerStore
} from "@watasu/core";
import {
  loadHostedPostgresRuntimeConfig,
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

export function createPostgresPoolQueryClient(pool: {
  query(text: string, values: readonly unknown[]): Promise<Pick<QueryResult, "rows">>;
}): PostgresQueryClient {
  return {
    async query(text, values) {
      return pool.query(text, values);
    }
  };
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
