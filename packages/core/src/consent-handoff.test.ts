import { describe, expect, test } from "vitest";
import {
  parseAuthRequired,
  parseConsentStatus,
  buildConsentFragmentUrl,
  runConsentHandoff,
  type HandoffSubmitResponse
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

function authRequiredResponse(): HandoffSubmitResponse {
  return {
    httpStatus: 401,
    body: {
      ok: false,
      status: "auth_required",
      consent: { consent_url: "https://x/consent/t", poll_url: "https://x/consent/t/status", expires_in: 600 }
    }
  };
}

describe("runConsentHandoff", () => {
  test("test_delivered_first_try_skips_consent", async () => {
    const opened: string[] = [];
    const result = await runConsentHandoff(
      {
        submit: async () => ({ httpStatus: 202, body: { ok: true, status: "delivered" } }),
        openConsentUrl: (u: string) => { opened.push(u); },
        pollConsent: async () => ({ status: "pending" }),
        sleep: async () => {}
      },
      { plaintext: "{}" }
    );
    expect(result).toEqual({ ok: true, body: { ok: true, status: "delivered" } });
    expect(opened).toEqual([]);
  });

  test("test_pause_open_poll_resubmit_delivered", async () => {
    const opened: string[] = [];
    const submitCalls: (string | undefined)[] = [];
    let polls = 0;
    const result = await runConsentHandoff(
      {
        submit: async (token?: string) => {
          submitCalls.push(token);
          return token === undefined
            ? authRequiredResponse()
            : { httpStatus: 202, body: { ok: true, status: "delivered", token } };
        },
        openConsentUrl: (u: string) => { opened.push(u); },
        pollConsent: async () => {
          polls += 1;
          return polls < 2 ? { status: "pending" } : { status: "approved", receipt: "R" };
        },
        sleep: async () => {}
      },
      { plaintext: '{"n":"x"}', pollIntervalMs: 10, maxWaitMs: 1000 }
    );
    expect(opened).toEqual(["https://x/consent/t#" + encodeURIComponent('{"n":"x"}')]);
    expect(submitCalls).toEqual([undefined, "R"]);
    expect(result).toEqual({ ok: true, body: { ok: true, status: "delivered", token: "R" } });
  });

  test("test_timeout_when_never_approved", async () => {
    const result = await runConsentHandoff(
      {
        submit: async () => authRequiredResponse(),
        openConsentUrl: () => {},
        pollConsent: async () => ({ status: "pending" }),
        sleep: async () => {}
      },
      { plaintext: "{}", pollIntervalMs: 100, maxWaitMs: 250 }
    );
    expect(result).toEqual({ ok: false, code: "consent_timeout" });
  });

  test("test_non_auth_error_is_submit_failed", async () => {
    const result = await runConsentHandoff(
      {
        submit: async () => ({ httpStatus: 400, body: { ok: false, error: { code: "bad" } } }),
        openConsentUrl: () => {},
        pollConsent: async () => ({ status: "pending" }),
        sleep: async () => {}
      },
      { plaintext: "{}" }
    );
    expect(result).toEqual({ ok: false, code: "submit_failed", detail: { ok: false, error: { code: "bad" } } });
  });
});
