import { describe, expect, test } from "vitest";
import { Readable } from "node:stream";
import {
  createHostedProductionServerFromEnv,
  runHostedPostgresRetentionJobFromEnv,
  createSignedHeaderIdentityProviderFromEnv,
  createHostedPostgresLedgerStoreFromEnv,
  createNodePostgresPoolConfig,
  createPostgresPoolQueryClient,
  formatHostedCommandError,
  loadHostedPublishInviteStoreFromEnv,
  loadHostedRetentionJobConfig,
  loadHostedIdentityProviderConfig,
  parseHostedRetentionArgs
} from "./index.js";

const hostedIdentitySigningSecret = "unit-fixture-hosted-identity-secret-with-enough-entropy";
const hostedMcpBearerToken = "unit-fixture-hosted-mcp-bearer-token-with-enough-entropy";

describe("hosted production runtime package", () => {
  test("test_hosted_production_server_from_env_constructs_closed_server", () => {
    // Arrange / Act
    const runtime = createHostedProductionServerFromEnv({
      env: {
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_MCP_BEARER_TOKEN: hostedMcpBearerToken,
        WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
        PORT: "10000"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z")
    });

    // Assert
    expect(runtime.config).toEqual({
      host: "0.0.0.0",
      publicBaseUrl: "https://api.watasu.ai",
      port: 10000
    });
    expect(runtime.server.listening).toBe(false);
    runtime.server.close();
  });

  test("test_hosted_publish_invites_env_loads_hash_only_records", () => {
    const store = loadHostedPublishInviteStoreFromEnv({
      WATASU_HOSTED_PUBLISH_INVITES_JSON: JSON.stringify([
        {
          token: "friend_invite_token",
          owner_id: "owner-a",
          tenant_id: "tenant-a",
          roles: ["publisher"],
          expires_at: "2026-06-17T00:00:00.000Z",
          max_publish_count: 2
        }
      ])
    });

    expect(store?.resolveToken("friend_invite_token", new Date("2026-06-16T00:00:00.000Z"))).toMatchObject({
      ok: true,
      identity: {
        tenant_id: "tenant-a",
        owner_id: "owner-a",
        roles: ["publisher"]
      }
    });
    expect(JSON.stringify(store?.listRecords())).not.toContain("friend_invite_token");
  });

  test("test_hosted_production_server_from_env_mounts_mcp_auth_challenge", async () => {
    // Arrange
    const runtime = createHostedProductionServerFromEnv({
      env: {
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_MCP_BEARER_TOKEN: hostedMcpBearerToken,
        WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
        PORT: "10000"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z")
    });
    const request = Readable.from([]) as Readable & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    request.headers = {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25"
    };
    request.method = "POST";
    request.url = "/mcp";
    const response = captureHostedResponse();

    // Act
    runtime.server.emit("request", request, response.response);
    const handled = await response.ended;

    // Assert
    expect(handled.status).toBe(401);
    expect(handled.headers["www-authenticate"]).toBe(
      "Bearer resource_metadata=\"https://api.watasu.ai/.well-known/oauth-protected-resource\", scope=\"watasu:publish watasu:ledger:read\""
    );
    expect(handled.headers["x-content-type-options"]).toBe("nosniff");
    expect(handled.body).toContain("\"code\":\"mcp_transport_auth_required\"");
    runtime.server.close();
  });

  test("test_hosted_production_server_from_env_serves_mcp_protected_resource_metadata", async () => {
    // Arrange
    const runtime = createHostedProductionServerFromEnv({
      env: {
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_MCP_BEARER_TOKEN: hostedMcpBearerToken,
        WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
        PORT: "10000"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z")
    });
    const request = Readable.from([]) as Readable & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    request.headers = {
      accept: "application/json"
    };
    request.method = "GET";
    request.url = "/.well-known/oauth-protected-resource";
    const response = captureHostedResponse();

    // Act
    runtime.server.emit("request", request, response.response);
    const handled = await response.ended;

    // Assert
    expect(handled.status).toBe(200);
    expect(handled.headers).toMatchObject({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    });
    expect(JSON.parse(handled.body)).toEqual({
      resource: "https://api.watasu.ai/mcp",
      authorization_servers: ["https://api.watasu.ai"],
      scopes_supported: ["watasu:publish", "watasu:ledger:read"],
      bearer_methods_supported: ["header"]
    });
    expect(handled.body).not.toContain("payload");
    expect(handled.body).not.toContain("secret");
    runtime.server.close();
  });

  test("test_hosted_production_server_from_env_rejects_non_get_mcp_metadata_requests", async () => {
    // Arrange
    const runtime = createHostedProductionServerFromEnv({
      env: {
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_MCP_BEARER_TOKEN: hostedMcpBearerToken,
        WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
        PORT: "10000"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z")
    });
    const request = Readable.from(["ignored"]) as Readable & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    request.headers = {
      accept: "application/json"
    };
    request.method = "POST";
    request.url = "/.well-known/oauth-protected-resource";
    const response = captureHostedResponse();

    // Act
    runtime.server.emit("request", request, response.response);
    const handled = await response.ended;

    // Assert
    expect(handled.status).toBe(405);
    expect(handled.headers).toMatchObject({
      allow: "GET",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    });
    expect(handled.body).toContain("\"code\":\"method_not_allowed\"");
    expect(handled.body).not.toContain("scopes_supported");
    runtime.server.close();
  });

  test("test_hosted_production_server_from_env_rejects_invalid_public_base_url", () => {
    expect(() =>
      createHostedProductionServerFromEnv({
        env: {
          WATASU_IDENTITY_PROVIDER: "signed_headers",
          WATASU_MCP_BEARER_TOKEN: hostedMcpBearerToken,
          WATASU_PUBLIC_BASE_URL: "http://api.watasu.ai",
          WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
          PORT: "10000"
        },
        now: () => new Date("2026-06-15T00:00:00.000Z")
      })
    ).toThrow("WATASU_PUBLIC_BASE_URL must use https outside local loopback.");
  });

  test("test_hosted_production_server_from_env_rejects_web_postgres_store_until_wired", () => {
    expect(() =>
      createHostedProductionServerFromEnv({
        env: {
          WATASU_IDENTITY_PROVIDER: "signed_headers",
          WATASU_MCP_BEARER_TOKEN: hostedMcpBearerToken,
          WATASU_METADATA_LEDGER_STORE: "postgres",
          WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
          WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai",
          WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
          PORT: "10000"
        },
        now: () => new Date("2026-06-15T00:00:00.000Z")
      })
    ).toThrow("WATASU_METADATA_LEDGER_STORE must be disabled for hosted production web runtime.");
  });

  test("test_hosted_production_server_from_env_rejects_web_database_url_even_when_store_disabled", () => {
    expect(() =>
      createHostedProductionServerFromEnv({
        env: {
          WATASU_IDENTITY_PROVIDER: "signed_headers",
          WATASU_MCP_BEARER_TOKEN: hostedMcpBearerToken,
          WATASU_METADATA_LEDGER_STORE: "disabled",
          WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
          WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai",
          WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
          PORT: "10000"
        },
        now: () => new Date("2026-06-15T00:00:00.000Z")
      })
    ).toThrow("WATASU_POSTGRES_URL must not be set for hosted production web runtime.");
  });

  test("test_identity_provider_config_requires_signing_secret_for_signed_headers", () => {
    expect(() =>
      loadHostedIdentityProviderConfig({
        WATASU_IDENTITY_PROVIDER: "signed_headers"
      })
    ).toThrow("WATASU_SERVICE_IDENTITY_SIGNING_SECRET is required when WATASU_IDENTITY_PROVIDER=signed_headers.");
  });

  test("test_hosted_production_server_from_env_requires_mcp_bearer_token", () => {
    expect(() =>
      createHostedProductionServerFromEnv({
        env: {
          WATASU_IDENTITY_PROVIDER: "signed_headers",
          WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai",
          WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
          PORT: "10000"
        },
        now: () => new Date("2026-06-15T00:00:00.000Z")
      })
    ).toThrow("WATASU_MCP_BEARER_TOKEN is required for hosted MCP transport.");
  });

  test("test_identity_provider_config_rejects_short_signing_secret", () => {
    expect(() =>
      loadHostedIdentityProviderConfig({
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: "short-secret"
      })
    ).toThrow("WATASU_SERVICE_IDENTITY_SIGNING_SECRET must be at least 32 bytes.");
  });

  test("test_identity_provider_config_rejects_documented_placeholder_signing_secret", () => {
    expect(() =>
      loadHostedIdentityProviderConfig({
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: "test-deployment-identity-secret-with-enough-entropy"
      })
    ).toThrow("WATASU_SERVICE_IDENTITY_SIGNING_SECRET must not use a documented test or placeholder value.");
  });

  test("test_identity_provider_config_rejects_partial_numeric_max_skew", () => {
    expect(() =>
      loadHostedIdentityProviderConfig({
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
        WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS: "60x"
      })
    ).toThrow("WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS must be a positive integer.");
  });

  test("test_identity_provider_config_rejects_excessive_max_skew", () => {
    expect(() =>
      loadHostedIdentityProviderConfig({
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret,
        WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS: "301"
      })
    ).toThrow("WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS must be between 1 and 300.");
  });

  test("test_retention_job_config_reads_tenant_and_days", () => {
    const config = loadHostedRetentionJobConfig({
      WATASU_RETENTION_TENANT_ID: "tenant-a",
      WATASU_METADATA_RETENTION_DAYS: "14"
    });

    expect(config).toEqual({
      tenantId: "tenant-a",
      retentionDays: 14,
      dryRunDefault: false
    });
  });

  test("test_retention_job_config_reads_dry_run_default", () => {
    const config = loadHostedRetentionJobConfig({
      WATASU_RETENTION_TENANT_ID: "tenant-a",
      WATASU_RETENTION_DRY_RUN: "true"
    });

    expect(config).toMatchObject({
      dryRunDefault: true
    });
  });

  test("test_retention_job_config_requires_tenant", () => {
    expect(() => loadHostedRetentionJobConfig({})).toThrow("WATASU_RETENTION_TENANT_ID is required.");
  });

  test("test_retention_job_config_rejects_partial_numeric_days", () => {
    expect(() =>
      loadHostedRetentionJobConfig({
        WATASU_RETENTION_TENANT_ID: "tenant-a",
        WATASU_METADATA_RETENTION_DAYS: "14x"
      })
    ).toThrow("WATASU_METADATA_RETENTION_DAYS must be a positive integer.");
  });

  test("test_parse_hosted_retention_args_accepts_dry_run_only", () => {
    expect(parseHostedRetentionArgs(["node", "retention-bin.js"])).toEqual({});
    expect(parseHostedRetentionArgs(["node", "retention-bin.js", "--dry-run"])).toEqual({
      dryRun: true
    });
  });

  test("test_parse_hosted_retention_args_rejects_unknown_arguments", () => {
    expect(() => parseHostedRetentionArgs(["node", "retention-bin.js", "--delete-now"])).toThrow(
      "Usage: pnpm --filter @watasu/hosted retention -- [--dry-run]"
    );
  });

  test("test_format_hosted_command_error_preserves_operator_actionable_config_errors", () => {
    expect(formatHostedCommandError(
      new Error("WATASU_POSTGRES_URL is required when WATASU_METADATA_LEDGER_STORE=postgres."),
      "Hosted retention command failed."
    )).toBe("WATASU_POSTGRES_URL is required when WATASU_METADATA_LEDGER_STORE=postgres.");
  });

  test("test_format_hosted_command_error_preserves_missing_secret_variable_name", () => {
    const message = formatHostedCommandError(
      new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET is required when WATASU_IDENTITY_PROVIDER=signed_headers."),
      "Hosted production startup failed."
    );

    expect(message).toBe(
      "WATASU_SERVICE_IDENTITY_SIGNING_SECRET is required when WATASU_IDENTITY_PROVIDER=signed_headers."
    );
  });

  test("test_format_hosted_command_error_hides_untrusted_error_details", () => {
    const message = formatHostedCommandError(
      new Error("connect failed for postgres://user:password@db.example.com/watasu"),
      "Hosted retention command failed."
    );

    expect(message).toBe("Hosted retention command failed.");
    expect(message).not.toContain("postgres://");
    expect(message).not.toContain("password");
  });

  test("test_format_hosted_command_error_hides_secret_like_config_values", () => {
    const message = formatHostedCommandError(
      new Error("WATASU_POSTGRES_URL postgres://user:password@db.example.com/watasu failed"),
      "Hosted retention command failed."
    );

    expect(message).toBe("Hosted retention command failed.");
    expect(message).not.toContain("postgres://");
    expect(message).not.toContain("password");
  });

  test("test_signed_header_identity_provider_from_env_resolves_principal", () => {
    // Arrange
    const identityProvider = createSignedHeaderIdentityProviderFromEnv({
      env: {
        WATASU_IDENTITY_PROVIDER: "signed_headers",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret
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

  test("test_hosted_postgres_retention_job_from_env_deletes_expired_rows_and_closes_pool", async () => {
    // Arrange
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    let closed = false;

    // Act
    const result = await runHostedPostgresRetentionJobFromEnv({
      env: {
        WATASU_METADATA_LEDGER_STORE: "postgres",
        WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
        WATASU_POSTGRES_RUN_MIGRATIONS: "false",
        WATASU_RETENTION_TENANT_ID: "tenant-a",
        WATASU_METADATA_RETENTION_DAYS: "7"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      createPool() {
        return {
          async query(text, values) {
            queries.push({
              text,
              values
            });
            return {
              rows: text.includes("select")
                ? [
                    {
                      request_id: "request-a",
                      request_version: "v1",
                      idempotency_key: "expired-submit",
                      submitted_at: "2026-06-01T00:00:00.000Z",
                      delivered_at: "2026-06-01T00:00:01.000Z",
                      delivery_status: "delivered",
                      destination_url_hash: "sha256:destination",
                      encrypted_payload_hash: "sha256:payload"
                    }
                  ]
                : []
            };
          },
          async end() {
            closed = true;
          }
        };
      }
    });

    // Assert
    expect(result).toEqual({
      ok: true,
      checked_at: "2026-06-15T00:00:00.000Z",
      retention_days: 7,
      tenant_id: "tenant-a",
      scanned: 1,
      deleted: 1,
      retained: 0
    });
    expect(queries[0]?.text).toContain("select");
    expect(queries[1]?.text).toContain("delete from watasu_delivery_ledger");
    expect(closed).toBe(true);
    expect(JSON.stringify(queries)).not.toContain("postgres://db.example.com/watasu");
    expect(JSON.stringify(queries)).not.toContain("\"encrypted_payload\"");
  });

  test("test_hosted_postgres_retention_job_from_env_requires_postgres_store", async () => {
    await expect(runHostedPostgresRetentionJobFromEnv({
      env: {
        WATASU_METADATA_LEDGER_STORE: "disabled",
        WATASU_RETENTION_TENANT_ID: "tenant-a"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z")
    })).rejects.toThrow("WATASU_METADATA_LEDGER_STORE must be postgres for hosted retention runtime.");
  });

  test("test_hosted_postgres_retention_job_from_env_rejects_web_identity_secret", async () => {
    let createPoolCalled = false;

    await expect(runHostedPostgresRetentionJobFromEnv({
      env: {
        WATASU_METADATA_LEDGER_STORE: "postgres",
        WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
        WATASU_RETENTION_TENANT_ID: "tenant-a",
        WATASU_SERVICE_IDENTITY_SIGNING_SECRET: hostedIdentitySigningSecret
      },
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      createPool() {
        createPoolCalled = true;
        throw new Error("pool must not be created");
      }
    })).rejects.toThrow("WATASU_SERVICE_IDENTITY_SIGNING_SECRET must not be set for hosted retention runtime.");

    expect(createPoolCalled).toBe(false);
  });

  test("test_hosted_postgres_retention_job_from_env_dry_run_does_not_delete_rows", async () => {
    // Arrange
    const queries: Array<{
      text: string;
      values: readonly unknown[];
    }> = [];
    let closed = false;

    // Act
    const result = await runHostedPostgresRetentionJobFromEnv({
      dryRun: true,
      env: {
        WATASU_METADATA_LEDGER_STORE: "postgres",
        WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
        WATASU_POSTGRES_RUN_MIGRATIONS: "false",
        WATASU_RETENTION_TENANT_ID: "tenant-a",
        WATASU_METADATA_RETENTION_DAYS: "7"
      },
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      createPool() {
        return {
          async query(text, values) {
            queries.push({
              text,
              values
            });
            return {
              rows: text.includes("select")
                ? [
                    {
                      request_id: "request-a",
                      request_version: "v1",
                      idempotency_key: "expired-submit",
                      submitted_at: "2026-06-01T00:00:00.000Z",
                      delivered_at: "2026-06-01T00:00:01.000Z",
                      delivery_status: "delivered",
                      destination_url_hash: "sha256:destination",
                      encrypted_payload_hash: "sha256:payload"
                    }
                  ]
                : []
            };
          },
          async end() {
            closed = true;
          }
        };
      }
    });

    // Assert
    expect(result).toEqual({
      ok: true,
      dry_run: true,
      checked_at: "2026-06-15T00:00:00.000Z",
      retention_days: 7,
      tenant_id: "tenant-a",
      scanned: 1,
      deleted: 0,
      retained: 1,
      would_delete: 1
    });
    expect(queries.map((query) => query.text).join("\n")).not.toContain("delete from watasu_delivery_ledger");
    expect(closed).toBe(true);
    expect(JSON.stringify(queries)).not.toContain("postgres://db.example.com/watasu");
  });
});

type CapturedHostedResponse = {
  body: string;
  headers: Record<string, string>;
  status: number;
};

function captureHostedResponse(): {
  ended: Promise<CapturedHostedResponse>;
  response: {
    end(body?: string): void;
    setHeader(name: string, value: string | number | readonly string[]): void;
    writeHead(status: number, headers?: Record<string, string | number | readonly string[]>): void;
  };
} {
  let status = 0;
  const headers: Record<string, string> = {};
  let resolveEnded: (value: CapturedHostedResponse) => void = () => {};
  const ended = new Promise<CapturedHostedResponse>((resolve) => {
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
