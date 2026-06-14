import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildHostedCanaryCheckUrls,
  buildHostedCanarySuccessReport,
  defaultHostedCanaryTimeoutMs,
  formatHostedCanaryRequestError,
  formatHostedCanaryResponseReadError,
  maxHostedCanaryTimeoutMs,
  hostedCanaryUnpublishedRequestId,
  parseHostedCanaryBaseUrl,
  resolveHostedCanaryTimeoutMs,
  withHostedCanaryTimeout,
  resolveHostedCanaryBaseUrl
} from "../../../scripts/hosted-canary-helpers.mjs";

describe("hosted canary helpers", () => {
  test("test_parse_hosted_canary_base_url_requires_value", () => {
    expect(() => parseHostedCanaryBaseUrl(undefined)).toThrow("WATASU_CANARY_BASE_URL is required.");
    expect(() => parseHostedCanaryBaseUrl("   ")).toThrow("WATASU_CANARY_BASE_URL is required.");
  });

  test("test_parse_hosted_canary_base_url_requires_https_for_non_local_targets", () => {
    expect(() => parseHostedCanaryBaseUrl("http://api.watasu.ai")).toThrow(
      "WATASU_CANARY_BASE_URL must use https outside local loopback targets."
    );
  });

  test("test_parse_hosted_canary_base_url_rejects_url_credentials", () => {
    expect(() => parseHostedCanaryBaseUrl("https://token@api.watasu.ai")).toThrow(
      "WATASU_CANARY_BASE_URL must not include username or password credentials."
    );
    expect(() => parseHostedCanaryBaseUrl("https://user:password@api.watasu.ai")).toThrow(
      "WATASU_CANARY_BASE_URL must not include username or password credentials."
    );
  });

  test("test_parse_hosted_canary_base_url_rejects_path_query_and_fragment", () => {
    expect(() => parseHostedCanaryBaseUrl("https://api.watasu.ai/nested")).toThrow(
      "WATASU_CANARY_BASE_URL must not include a path, query, or fragment."
    );
    expect(() => parseHostedCanaryBaseUrl("https://api.watasu.ai?debug=true")).toThrow(
      "WATASU_CANARY_BASE_URL must not include a path, query, or fragment."
    );
    expect(() => parseHostedCanaryBaseUrl("https://api.watasu.ai#health")).toThrow(
      "WATASU_CANARY_BASE_URL must not include a path, query, or fragment."
    );
  });

  test("test_parse_hosted_canary_base_url_allows_https_targets", () => {
    const url = parseHostedCanaryBaseUrl("https://api.watasu.ai");

    expect(url.origin).toBe("https://api.watasu.ai");
  });

  test("test_parse_hosted_canary_base_url_allows_local_http_targets", () => {
    expect(parseHostedCanaryBaseUrl("http://127.0.0.1:8789").origin).toBe("http://127.0.0.1:8789");
    expect(parseHostedCanaryBaseUrl("http://localhost:8789").origin).toBe("http://localhost:8789");
  });

  test("test_resolve_hosted_canary_base_url_accepts_cli_argument", () => {
    const url = resolveHostedCanaryBaseUrl({
      env: {},
      argv: ["node", "scripts/hosted-canary.mjs", "https://api.watasu.ai"]
    });

    expect(url.origin).toBe("https://api.watasu.ai");
  });

  test("test_resolve_hosted_canary_base_url_ignores_pnpm_argument_separator", () => {
    const url = resolveHostedCanaryBaseUrl({
      env: {},
      argv: ["node", "scripts/hosted-canary.mjs", "--", "https://api.watasu.ai"]
    });

    expect(url.origin).toBe("https://api.watasu.ai");
  });

  test("test_resolve_hosted_canary_base_url_rejects_ambiguous_sources", () => {
    expect(() =>
      resolveHostedCanaryBaseUrl({
        env: {
          WATASU_CANARY_BASE_URL: "https://api.watasu.ai"
        },
        argv: ["node", "scripts/hosted-canary.mjs", "https://other.example.com"]
      })
    ).toThrow("Provide WATASU_CANARY_BASE_URL or one canary URL argument, not both.");
  });

  test("test_resolve_hosted_canary_base_url_rejects_extra_arguments", () => {
    expect(() =>
      resolveHostedCanaryBaseUrl({
        env: {},
        argv: ["node", "scripts/hosted-canary.mjs", "https://api.watasu.ai", "extra"]
      })
    ).toThrow("Usage: pnpm canary:hosted -- <https://host>");
  });

  test("test_resolve_hosted_canary_timeout_uses_default", () => {
    expect(resolveHostedCanaryTimeoutMs({})).toBe(defaultHostedCanaryTimeoutMs);
  });

  test("test_resolve_hosted_canary_timeout_reads_positive_integer_env", () => {
    expect(resolveHostedCanaryTimeoutMs({
      WATASU_CANARY_TIMEOUT_MS: "2500"
    })).toBe(2500);
    expect(resolveHostedCanaryTimeoutMs({
      WATASU_CANARY_TIMEOUT_MS: String(maxHostedCanaryTimeoutMs)
    })).toBe(maxHostedCanaryTimeoutMs);
  });

  test("test_resolve_hosted_canary_timeout_rejects_partial_numeric_env", () => {
    expect(() => resolveHostedCanaryTimeoutMs({
      WATASU_CANARY_TIMEOUT_MS: "2500ms"
    })).toThrow("WATASU_CANARY_TIMEOUT_MS must be a positive integer.");
  });

  test("test_resolve_hosted_canary_timeout_rejects_values_over_maximum", () => {
    expect(() => resolveHostedCanaryTimeoutMs({
      WATASU_CANARY_TIMEOUT_MS: String(maxHostedCanaryTimeoutMs + 1)
    })).toThrow("WATASU_CANARY_TIMEOUT_MS must be between 1 and 60000.");
  });

  test("test_with_hosted_canary_timeout_adds_abort_signal", () => {
    const init = withHostedCanaryTimeout({
      method: "GET",
      redirect: "manual"
    }, 2500);

    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("test_format_hosted_canary_request_error_hides_secret_like_details", () => {
    const message = formatHostedCanaryRequestError(
      "Health check",
      new Error("fetch failed for https://user:password@api.watasu.ai?token=secret")
    );

    expect(message).toBe("Health check request failed.");
  });

  test("test_format_hosted_canary_request_error_reports_timeout_without_stack_details", () => {
    const error = new DOMException("The operation was aborted", "TimeoutError");

    expect(formatHostedCanaryRequestError("MCP endpoint", error)).toBe("MCP endpoint request timed out.");
  });

  test("test_format_hosted_canary_response_read_error_hides_secret_like_details", () => {
    const message = formatHostedCanaryResponseReadError(
      "Health check",
      new Error("body read failed for https://user:password@api.watasu.ai?token=secret")
    );

    expect(message).toBe("Health check response body could not be read.");
  });

  test("test_build_hosted_canary_check_urls_includes_health_and_public_routes", () => {
    const urls = buildHostedCanaryCheckUrls(parseHostedCanaryBaseUrl("https://api.watasu.ai"));

    expect(urls).toEqual({
      health: "https://api.watasu.ai/health",
      root: "https://api.watasu.ai/",
      unpublishedAgentCard: `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/agent-card.json`,
      unpublishedPlaintextSchema: `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/schemas/plaintext.json`,
      unpublishedEnvelopeSchema: `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/schemas/envelope.json`,
      unpublishedSubmit: `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/submit`,
      mcpEndpoint: "https://api.watasu.ai/mcp",
      mcpProtectedResourceMetadata: "https://api.watasu.ai/.well-known/oauth-protected-resource",
      unsafeEncodedRequestId: "https://api.watasu.ai/requests/__watasu%2Fcanary__/agent-card.json"
    });
  });

  test("test_build_hosted_canary_success_report_includes_timeout_evidence", () => {
    const urls = buildHostedCanaryCheckUrls(parseHostedCanaryBaseUrl("https://api.watasu.ai"));
    const report = buildHostedCanarySuccessReport({
      checkedAt: "2026-06-15T00:00:00.000Z",
      status: 200,
      timeoutMs: 2500,
      urls
    });

    expect(report).toEqual({
      ok: true,
      checked_at: "2026-06-15T00:00:00.000Z",
      checked_origin: "https://api.watasu.ai",
      checked_url: "https://api.watasu.ai/health",
      checked_public_routes: [
        `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/agent-card.json`,
        `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/schemas/plaintext.json`,
        `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/schemas/envelope.json`,
        `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/submit`,
        "https://api.watasu.ai/mcp",
        "https://api.watasu.ai/.well-known/oauth-protected-resource",
        "https://api.watasu.ai/requests/__watasu%2Fcanary__/agent-card.json"
      ],
      checked_method_boundaries: [
        {
          url: "https://api.watasu.ai/.well-known/oauth-protected-resource",
          allowed_methods: ["GET"],
          rejected_methods: ["POST"]
        }
      ],
      checked_not_found_routes: [
        "https://api.watasu.ai/",
        "https://api.watasu.ai/requests/__watasu%2Fcanary__/agent-card.json"
      ],
      checked_headers: [
        "cache-control",
        "content-security-policy",
        "referrer-policy",
        "x-content-type-options"
      ],
      checked_timeout_ms: 2500,
      status: 200
    });
  });

  test("test_hosted_canary_helper_declaration_includes_unsafe_route_url", () => {
    const declaration = readFileSync(new URL("../../../scripts/hosted-canary-helpers.d.mts", import.meta.url), "utf8");

    expect(declaration).toContain("unsafeEncodedRequestId: string;");
  });

  test("test_hosted_canary_helper_declaration_includes_mcp_endpoint_url", () => {
    const declaration = readFileSync(new URL("../../../scripts/hosted-canary-helpers.d.mts", import.meta.url), "utf8");

    expect(declaration).toContain("mcpEndpoint: string;");
  });

  test("test_hosted_canary_helper_declaration_includes_mcp_metadata_url", () => {
    const declaration = readFileSync(new URL("../../../scripts/hosted-canary-helpers.d.mts", import.meta.url), "utf8");

    expect(declaration).toContain("mcpProtectedResourceMetadata: string;");
  });
});
