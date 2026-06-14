import { describe, expect, test } from "vitest";
import {
  buildHostedCanaryCheckUrls,
  hostedCanaryUnpublishedRequestId,
  parseHostedCanaryBaseUrl,
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

  test("test_build_hosted_canary_check_urls_includes_health_and_public_routes", () => {
    const urls = buildHostedCanaryCheckUrls(parseHostedCanaryBaseUrl("https://api.watasu.ai"));

    expect(urls).toEqual({
      health: "https://api.watasu.ai/health",
      unpublishedAgentCard: `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/agent-card.json`,
      unpublishedSubmit: `https://api.watasu.ai/requests/${hostedCanaryUnpublishedRequestId}/submit`
    });
  });
});
