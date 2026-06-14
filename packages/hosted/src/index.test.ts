import { describe, expect, test } from "vitest";
import {
  createHostedProductionServerFromEnv,
  createSignedHeaderIdentityProviderFromEnv,
  createHostedPostgresLedgerStoreFromEnv,
  createNodePostgresPoolConfig,
  createPostgresPoolQueryClient,
  loadHostedIdentityProviderConfig
} from "./index.js";

describe("hosted production runtime package", () => {
  test("test_hosted_production_server_from_env_constructs_closed_server", () => {
    // Arrange / Act
    const runtime = createHostedProductionServerFromEnv({
      env: {
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: "test-deployment-identity-secret-with-enough-entropy",
        PORT: "10000"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z")
    });

    // Assert
    expect(runtime.config).toEqual({
      host: "0.0.0.0",
      port: 10000
    });
    expect(runtime.server.listening).toBe(false);
    runtime.server.close();
  });

  test("test_identity_provider_config_requires_signing_secret_for_signed_headers", () => {
    expect(() =>
      loadHostedIdentityProviderConfig({
        WATASU_IDENTITY_PROVIDER: "signed_headers"
      })
    ).toThrow("WATASU_SERVICE_IDENTITY_SIGNING_SECRET is required when WATASU_IDENTITY_PROVIDER=signed_headers.");
  });

  test("test_signed_header_identity_provider_from_env_resolves_principal", () => {
    // Arrange
    const identityProvider = createSignedHeaderIdentityProviderFromEnv({
      env: {
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: "test-deployment-identity-secret-with-enough-entropy"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z")
    });
    const headers = identityProvider.createHeaders({
      tenantId: "tenant-a",
      roles: ["publisher"],
      issuedAt: new Date("2026-06-15T00:00:00.000Z")
    });

    // Act
    const principal = identityProvider.resolvePrincipal({
      method: "POST",
      path: "/requests/request-a/publish",
      headers,
      body: "{\"tenant_id\":\"attacker\"}"
    });

    // Assert
    expect(principal).toEqual({
      tenant_id: "tenant-a",
      roles: ["publisher"]
    });
  });

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
