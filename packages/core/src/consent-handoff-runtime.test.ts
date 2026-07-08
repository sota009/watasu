import { describe, expect, test } from "vitest";
import { resolveOpenCommand, submitWithConsent } from "./consent-handoff-runtime.js";
import {
  watasuA2aHttpJsonContentType,
  watasuA2aProtocolVersion
} from "./a2a.js";
import { watasuEncryptedIntakeExtensionUri } from "./agent-card.js";

describe("resolveOpenCommand", () => {
  test("test_macos_uses_open", () => {
    const c = resolveOpenCommand("darwin");
    expect(c.command).toBe("open");
    expect(c.args("https://x")).toEqual(["https://x"]);
  });

  test("test_windows_uses_cmd_start", () => {
    const c = resolveOpenCommand("win32");
    expect(c.command).toBe("cmd");
    expect(c.args("https://x")).toEqual(["/c", "start", "", '"https://x"']);
  });

  test("test_windows_quotes_url_so_metacharacters_do_not_split_command", () => {
    // cmd.exe's `start` treats `&`, `|`, `^` as command separators; quoting the
    // URL keeps a stray metacharacter from splitting into a second command.
    const c = resolveOpenCommand("win32");
    expect(c.args("https://x/consent#a&b")).toEqual([
      "/c",
      "start",
      "",
      '"https://x/consent#a&b"'
    ]);
  });

  test("test_linux_uses_xdg_open", () => {
    const c = resolveOpenCommand("linux");
    expect(c.command).toBe("xdg-open");
    expect(c.args("https://x")).toEqual(["https://x"]);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe("submitWithConsent", () => {
  test("test_end_to_end_wiring_pause_to_delivered", async () => {
    const opened: string[] = [];
    const posted: unknown[] = [];
    let submitCall = 0;
    let pollCall = 0;

    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        submitCall += 1;
        posted.push(JSON.parse(init.body as string));
        return submitCall === 1
          ? jsonResponse(401, {
              ok: false,
              status: "auth_required",
              consent: { consent_url: "https://x/consent/t", poll_url: "https://x/consent/t/status", expires_in: 600 }
            })
          : jsonResponse(202, { ok: true, status: "delivered" });
      }
      pollCall += 1;
      return pollCall < 2
        ? jsonResponse(200, { ok: true, status: "pending" })
        : jsonResponse(200, { ok: true, status: "approved", receipt: "RCPT" });
    }) as unknown as typeof fetch;

    const result = await submitWithConsent({
      submitUrl: "https://x/requests/r/submit",
      envelope: { message: { parts: [{ data: { request_id: "r" } }] } },
      plaintext: '{"name":"Alice"}',
      withReceipt: (env, token) => ({ ...(env as object), _token: token }),
      fetchImpl,
      openImpl: (u) => { opened.push(u); },
      sleepImpl: async () => {},
      pollIntervalMs: 10,
      maxWaitMs: 1000
    });

    expect(result).toEqual({ ok: true, body: { ok: true, status: "delivered" } });
    expect(opened).toEqual(["https://x/consent/t#" + encodeURIComponent('{"name":"Alice"}')]);
    expect(posted[1]).toEqual({ message: { parts: [{ data: { request_id: "r" } }] }, _token: "RCPT" });
  });

  test("test_submit_sends_a2a_protocol_headers", async () => {
    const postHeaders: Array<Record<string, string> | undefined> = [];
    const fetchImpl = (async (
      _url: string,
      init?: { method?: string; headers?: Record<string, string> }
    ) => {
      if (init?.method === "POST") {
        postHeaders.push(init.headers);
        return jsonResponse(202, { ok: true, status: "delivered" });
      }
      return jsonResponse(200, { ok: true, status: "pending" });
    }) as unknown as typeof fetch;

    await submitWithConsent({
      submitUrl: "https://x/requests/r/submit",
      envelope: { message: { parts: [{ data: { request_id: "r" } }] } },
      plaintext: '{"name":"Alice"}',
      withReceipt: (env) => env,
      fetchImpl,
      openImpl: () => {},
      sleepImpl: async () => {}
    });

    // The hosted submit endpoint is behind the A2A protocol gate, which rejects
    // anything that is not application/a2a+json with the version + extension
    // headers before the request ever reaches the consent gate.
    expect(postHeaders[0]).toEqual({
      "content-type": watasuA2aHttpJsonContentType,
      "a2a-version": watasuA2aProtocolVersion,
      "a2a-extensions": watasuEncryptedIntakeExtensionUri
    });
  });

  test("test_plaintext_never_enters_submit_body", async () => {
    const posted: string[] = [];
    const fetchImpl = (async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        posted.push(init.body as string);
        return jsonResponse(202, { ok: true, status: "delivered" });
      }
      return jsonResponse(200, { ok: true, status: "pending" });
    }) as unknown as typeof fetch;

    await submitWithConsent({
      submitUrl: "https://x/requests/r/submit",
      envelope: { message: { parts: [{ data: { request_id: "r" } }] } },
      plaintext: "SECRET_PII_VALUE",
      withReceipt: (env) => env,
      fetchImpl,
      openImpl: () => {},
      sleepImpl: async () => {}
    });

    for (const body of posted) {
      expect(body).not.toContain("SECRET_PII_VALUE");
    }
  });
});
