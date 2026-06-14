import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  buildHostedProductionRequest,
  createHostedProductionServer,
  loadHostedPublicBaseUrlConfig,
  loadHostedPostgresRuntimeConfig,
  loadHostedRuntimeConfig,
  isContentLengthOverLimit,
  readHostedRequestBody,
  withHostedSecurityHeaders,
  type HostedProductionRequest
} from "./hosted-server.js";

type CapturedHostedResponse = {
  body: string;
  headers: Record<string, string>;
  status: number;
};

describe("hosted production server runtime", () => {
  test("test_load_hosted_runtime_config_reads_env_defaults", () => {
    const config = loadHostedRuntimeConfig({});

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 8787
    });
  });

  test("test_load_hosted_runtime_config_prefers_platform_port", () => {
    const config = loadHostedRuntimeConfig({
      PORT: "10000",
      WATASU_HOSTED_PORT: "8787"
    });

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 10000
    });
  });

  test("test_load_hosted_runtime_config_rejects_invalid_port", () => {
    expect(() =>
      loadHostedRuntimeConfig({
        WATASU_HOSTED_PORT: "not-a-port"
      })
    ).toThrow("WATASU_HOSTED_PORT must be an integer between 1 and 65535.");
  });

  test("test_load_hosted_runtime_config_rejects_partial_numeric_port", () => {
    expect(() =>
      loadHostedRuntimeConfig({
        PORT: "10000abc"
      })
    ).toThrow("PORT or WATASU_HOSTED_PORT must be an integer between 1 and 65535.");
  });

  test("test_load_hosted_public_base_url_config_normalizes_https_url", () => {
    const config = loadHostedPublicBaseUrlConfig({
      WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai/"
    });

    expect(config).toEqual({
      publicBaseUrl: "https://api.watasu.ai"
    });
  });

  test("test_load_hosted_public_base_url_config_rejects_non_https_public_url", () => {
    expect(() =>
      loadHostedPublicBaseUrlConfig({
        WATASU_PUBLIC_BASE_URL: "http://api.watasu.ai"
      })
    ).toThrow("WATASU_PUBLIC_BASE_URL must use https outside local loopback.");
  });

  test("test_load_hosted_public_base_url_config_rejects_url_credentials", () => {
    expect(() =>
      loadHostedPublicBaseUrlConfig({
        WATASU_PUBLIC_BASE_URL: "https://user:pass@api.watasu.ai"
      })
    ).toThrow("WATASU_PUBLIC_BASE_URL must not include username or password.");
  });

  test("test_load_hosted_public_base_url_config_rejects_url_path", () => {
    expect(() =>
      loadHostedPublicBaseUrlConfig({
        WATASU_PUBLIC_BASE_URL: "https://api.watasu.ai/nested"
      })
    ).toThrow("WATASU_PUBLIC_BASE_URL must not include a path, query, or fragment.");
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

  test("test_load_hosted_postgres_runtime_config_rejects_partial_numeric_pool_max", () => {
    expect(() =>
      loadHostedPostgresRuntimeConfig({
        WATASU_METADATA_LEDGER_STORE: "postgres",
        WATASU_POSTGRES_URL: "postgres://db.example.com/watasu",
        WATASU_POSTGRES_POOL_MAX: "7x"
      })
    ).toThrow("WATASU_POSTGRES_POOL_MAX must be a positive integer.");
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

  test("test_create_hosted_production_server_delegates_prehandled_request_before_app", async () => {
    const server = createHostedProductionServer({
      async handle(_request: HostedProductionRequest) {
        throw new Error("app should not receive prehandled request");
      }
    }, {
      async beforeAppRequest(_request, response) {
        response.writeHead(401, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end("{\"ok\":false}\n");
        return true;
      }
    });
    const request = Readable.from(["body that should not reach the app"]) as Readable & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    request.headers = {};
    request.method = "POST";
    request.url = "/mcp";
    const response = captureHostedResponse();

    server.emit("request", request, response.response);
    const handled = await response.ended;

    expect(handled.status).toBe(401);
    expect(handled.headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    });
    expect(handled.body).toBe("{\"ok\":false}\n");
    server.close();
  });

  test("test_create_hosted_production_server_returns_low_information_500_when_app_throws", async () => {
    const server = createHostedProductionServer({
      async handle(_request: HostedProductionRequest) {
        throw new Error("secret database payload leaked");
      }
    });
    const request = Readable.from([]) as Readable & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    request.headers = {};
    request.method = "GET";
    request.url = "/requests/request-a/ledger";
    const response = captureHostedResponse();

    server.emit("request", request, response.response);
    const handled = await response.ended;

    expect(handled.status).toBe(500);
    expect(handled.headers).toMatchObject({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    });
    expect(handled.body).toContain("\"code\":\"internal_server_error\"");
    expect(handled.body).not.toContain("secret");
    expect(handled.body).not.toContain("database");
    expect(handled.body).not.toContain("payload");
    server.close();
  });

  test("test_with_hosted_security_headers_adds_default_api_headers", () => {
    const headers = withHostedSecurityHeaders({
      "content-type": "application/json; charset=utf-8"
    });

    expect(headers).toEqual({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    });
  });

  test("test_with_hosted_security_headers_enforces_security_headers", () => {
    const headers = withHostedSecurityHeaders({
      "cache-control": "private, max-age=30",
      "content-type": "application/json; charset=utf-8"
    });

    expect(headers["cache-control"]).toBe("no-store");
  });

  test("test_read_hosted_request_body_rejects_body_over_limit", async () => {
    const stream = Readable.from(["123", "45"]);

    await expect(readHostedRequestBody(stream, {
      maxBytes: 4
    })).rejects.toMatchObject({
      code: "request_body_too_large"
    });
  });

  test("test_content_length_limit_ignores_partial_numeric_header", () => {
    const overLimit = isContentLengthOverLimit({
      "content-length": "5x"
    }, 4);

    expect(overLimit).toBe(false);
  });
});

function captureHostedResponse(): {
  ended: Promise<CapturedHostedResponse>;
  response: {
    end(body: string): void;
    setHeader(name: string, value: string | number | readonly string[]): void;
    writeHead(status: number, headers: Record<string, string>): void;
  };
} {
  let status = 0;
  let headers: Record<string, string> = {};
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
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = {
          ...headers,
          ...nextHeaders
        };
      },
      end(body) {
        resolveEnded({
          body,
          headers,
          status
        });
      }
    }
  };
}
