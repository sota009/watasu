import { describe, expect, test } from "vitest";
import {
  createHostedPostgresLedgerStoreFromEnv,
  createNodePostgresPoolConfig,
  createPostgresPoolQueryClient
} from "./index.js";

describe("hosted production runtime package", () => {
  test("test_pool_query_client_delegates_parameterized_query", async () => {
    // Arrange
    const calls: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    const queryClient = createPostgresPoolQueryClient({
      async query(text, values) {
        calls.push({
          text,
          values
        });
        return {
          rows: [{ ok: true }]
        };
      }
    });

    // Act
    const result = await queryClient.query("select $1::text", ["tenant-a"]);

    // Assert
    expect(result.rows).toEqual([{ ok: true }]);
    expect(calls).toEqual([
      {
        text: "select $1::text",
        values: ["tenant-a"]
      }
    ]);
  });

  test("test_node_postgres_pool_config_uses_bounded_pool_and_ssl_require", () => {
    // Arrange / Act
    const config = createNodePostgresPoolConfig({
      mode: "postgres",
      databaseUrl: "postgres://db.example.com/watasu",
      poolMax: 7,
      ssl: "require",
      runMigrations: true
    });

    // Assert
    expect(config).toEqual({
      connectionString: "postgres://db.example.com/watasu",
      max: 7,
      ssl: {
        rejectUnauthorized: true
      }
    });
  });

  test("test_hosted_postgres_ledger_store_from_env_runs_migration_and_closes_pool", async () => {
    // Arrange
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    let closed = false;

    const runtime = await createHostedPostgresLedgerStoreFromEnv({
      env: {
        WATASU_METADATA_LEDGER_STORE: "postgres",
        WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
        WATASU_POSTGRES_POOL_MAX: "3"
      },
      tenantId: "tenant-a",
      createPool() {
        return {
          async query(text, values) {
            queries.push({
              text,
              values
            });
            return {
              rows: []
            };
          },
          async end() {
            closed = true;
          }
        };
      }
    });

    // Act
    await runtime.store.writeDeliveryAttempt({
      request_id: "request-a",
      request_version: "v1",
      idempotency_key: "submit-001",
      submitted_at: "2026-06-15T00:00:00.000Z",
      delivered_at: "2026-06-15T00:00:01.000Z",
      delivery_status: "delivered",
      destination_url_hash: "sha256:destination",
      encrypted_payload_hash: "sha256:payload"
    });
    await runtime.close();

    // Assert
    expect(queries[0]?.text).toContain("create table if not exists watasu_delivery_ledger");
    expect(queries[1]?.values[0]).toBe("tenant-a");
    expect(closed).toBe(true);
    expect(JSON.stringify(queries)).not.toContain("postgres://db.example.com/watasu");
    expect(JSON.stringify(queries)).not.toContain("\"encrypted_payload\"");
  });
});
