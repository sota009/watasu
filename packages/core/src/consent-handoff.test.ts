import { describe, expect, test } from "vitest";
import {
  parseAuthRequired,
  parseConsentStatus,
  buildConsentFragmentUrl
} from "./consent-handoff.js";

describe("parseAuthRequired", () => {
  test("test_extracts_consent_urls", () => {
    const body = {
      ok: false,
      status: "auth_required",
      consent: { consent_url: "https://x/consent/t", poll_url: "https://x/consent/t/status", expires_in: 600 }
    };
    expect(parseAuthRequired(body)).toEqual({
      consentUrl: "https://x/consent/t",
      pollUrl: "https://x/consent/t/status",
      expiresIn: 600
    });
  });

  test("test_non_auth_required_returns_undefined", () => {
    expect(parseAuthRequired({ ok: true, status: "delivered" })).toBeUndefined();
    expect(parseAuthRequired({ status: "auth_required" })).toBeUndefined();
    expect(parseAuthRequired(null)).toBeUndefined();
  });
});

describe("parseConsentStatus", () => {
  test("test_pending", () => {
    expect(parseConsentStatus({ ok: true, status: "pending" })).toEqual({ status: "pending" });
  });

  test("test_approved_with_receipt", () => {
    expect(parseConsentStatus({ ok: true, status: "approved", receipt: "jws.tok.en" }))
      .toEqual({ status: "approved", receipt: "jws.tok.en" });
  });

  test("test_approved_without_receipt_is_undefined", () => {
    expect(parseConsentStatus({ ok: true, status: "approved" })).toBeUndefined();
    expect(parseConsentStatus(null)).toBeUndefined();
  });
});

describe("buildConsentFragmentUrl", () => {
  test("test_appends_encoded_plaintext_fragment", () => {
    const url = buildConsentFragmentUrl("https://x/consent/t", '{"a":"b c"}');
    expect(url).toBe("https://x/consent/t#" + encodeURIComponent('{"a":"b c"}'));
  });
});
