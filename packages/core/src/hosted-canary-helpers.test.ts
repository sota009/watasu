import { describe, expect, test } from "vitest";
import { parseHostedCanaryBaseUrl } from "../../../scripts/hosted-canary-helpers.mjs";

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

  test("test_parse_hosted_canary_base_url_allows_https_targets", () => {
    const url = parseHostedCanaryBaseUrl("https://api.watasu.ai");

    expect(url.origin).toBe("https://api.watasu.ai");
  });

  test("test_parse_hosted_canary_base_url_allows_local_http_targets", () => {
    expect(parseHostedCanaryBaseUrl("http://127.0.0.1:8789").origin).toBe("http://127.0.0.1:8789");
    expect(parseHostedCanaryBaseUrl("http://localhost:8789").origin).toBe("http://localhost:8789");
  });
});
