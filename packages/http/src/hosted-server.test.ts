import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  buildHostedProductionRequest,
  createHostedProductionServer,
  loadHostedPostgresRuntimeConfig,
  loadHostedRuntimeConfig,
  readHostedRequestBody,
  type HostedProductionRequest
} from "./hosted-server.js";

describe("hosted production server runtime", () => {
  test("test_load_hosted_runtime_config_reads_env_defaults", () => {
    const config = loadHostedRuntimeConfig({});

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 8787
    });
  });

  test("test_load_hosted_runtime_config_rejects_invalid_port", () => {
    expect(() =>
      loadHostedRuntimeConfig({
        WATASU_HOSTED_PORT: "not-a-port"
      })
    ).toThrow("WATASU_HOSTED_PORT must be an integer between 1 and 65535.");
  });

  test("test_load_hosted_postgres_runtime_config_defaults_to_disabled", () => {
    const config = loadHostedPostgresRuntimeConfig({});

    expect(config).toEqual({
      mode: "disabled"
    });
  });

  test("test_load_hosted_postgres_runtime_config_requires_database_url_for_postgres_mode", () => {
    expect(() =>
      loadHostedPostgresRuntimeConfig({
        WATASU_METADATA_LEDGER_STORE: "postgres"
      })
    ).toThrow("WATASU_POSTGRES_URL is required when WATASU_METADATA_LEDGER_STORE=postgres.");
  });

  test("test_load_hosted_postgres_runtime_config_reads_pool_and_migration_settings", () => {
    const config = loadHostedPostgresRuntimeConfig({
      WATASU_METADATA_LEDGER_STORE: "postgres",
      WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
      WATASU_POSTGRES_POOL_MAX: "7",
      WATASU_POSTGRES_SSL: "require",
      WATASU_POSTGRES_RUN_MIGRATIONS: "false"
    });

    expect(config).toEqual({
      mode: "postgres",
      databaseUrl: "postgres://db.example.com/watasu",
      poolMax: 7,
      ssl: "require",
      runMigrations: false
    });
  });

  test("test_create_hosted_production_server_returns_node_http_server", () => {
    const server = createHostedProductionServer({
      async handle() {
        throw new Error("server should not handle a request without listen or emit");
      }
    });

    expect(server.listening).toBe(false);
    server.close();
  });

  test("test_build_hosted_production_request_uses_path_without_query", () => {
    const request = buildHostedProductionRequest({
      method: "GET",
      url: "/requests/request-a/ledger?debug=true",
      headers: {
        authorization: "Bearer test-token"
      },
      body: ""
    });

    expect(request).toEqual({
      method: "GET",
      path: "/requests/request-a/ledger",
      headers: {
        authorization: "Bearer test-token"
      },
      body: ""
    });
  });

  test("test_build_hosted_production_request_defaults_missing_url_to_root", () => {
    const request = buildHostedProductionRequest({
      method: "GET",
      url: undefined,
      headers: {},
      body: ""
    });

    expect(request.path).toBe("/");
  });

  test("test_create_hosted_production_server_can_be_constructed_with_app", () => {
    const server = createHostedProductionServer({
      async handle(_request: HostedProductionRequest) {
        return {
          status: 202,
          headers: {
            "content-type": "application/json; charset=utf-8"
          },
          body: "{\"ok\":true}\n"
        };
      }
    });

    expect(server.listening).toBe(false);
    server.close();
  });

  test("test_read_hosted_request_body_rejects_body_over_limit", async () => {
    const stream = Readable.from(["123", "45"]);

    await expect(readHostedRequestBody(stream, {
      maxBytes: 4
    })).rejects.toMatchObject({
      code: "request_body_too_large"
    });
  });
});
