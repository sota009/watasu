# watasu Consent-Handoff Shim (Path B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Path B client-side consent-handoff shim — a reusable `submitWithConsent()`
that turns watasu's `submit → 401 auth_required → human approves in browser → resubmit with
receipt → delivered` dance into one call, so any cloud/CLI user-side agent gets the consent
flow with ~one function instead of hand-rolled glue.

**Architecture:** A **pure orchestration loop** (`runConsentHandoff`) with all side effects
injected (submit, open-url, poll, sleep) so it is fully unit-testable; a set of **pure parsers**
for the wire shapes; a **Node runtime adapter** (`submitWithConsent`) that wires real `fetch`,
a platform URL opener, and `setTimeout`. The plaintext only ever enters the consent URL
**fragment** handed to the opener — never the submit body (which is the caller's pre-encrypted
envelope). watasu needs **zero** server changes; this is the `docs/superpowers/specs/2026-07-05-watasu-zero-install-agent-handoff-design.md`
"Path B" interim path.

**Tech Stack:** TypeScript (TS 6), Node ≥22, pnpm workspace, Vitest 4, `@watasu/core` (no new deps).

## Global Constraints

- Node ≥22, TypeScript 6, ESM (`"type": "module"`), `.js` import specifiers in TS source.
- Green gate before every commit: `pnpm test` (runs `pnpm typecheck` then `vitest run`).
  Expected baseline: 40 files / 456 tests pass; 0 new failures.
- Stage explicit paths (never `git add -A`). Commit trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and the session line.
- **No-custody invariant:** the plaintext MUST only ever be placed in the consent URL fragment
  (`consent_url#<plaintext>`). It MUST NOT be written into the submit body, logs, or any
  server-bound field. The submit body is the caller's already-encrypted envelope.
- No new runtime dependencies. Only `node:child_process` (new import in core) for the opener.
- Wire shapes are fixed by the server and must be matched verbatim:
  - `401` body: `{ ok:false, status:"auth_required", consent:{ consent_url, poll_url, expires_in } }`
  - status body: `{ ok:true, status:"pending" }` or `{ ok:true, status:"approved", receipt }`
  - resubmit: the same envelope with `consent_receipt_token` set on the message data.

---

### Task 1: Pure wire parsers + fragment URL builder

**Files:**
- Create: `packages/core/src/consent-handoff.ts`
- Create: `packages/core/src/consent-handoff.test.ts`
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Produces:
  - `interface AuthRequiredConsent { consentUrl: string; pollUrl: string; expiresIn: number }`
  - `type ConsentPollResult = { status: "pending" } | { status: "approved"; receipt: string }`
  - `parseAuthRequired(body: unknown): AuthRequiredConsent | undefined`
  - `parseConsentStatus(body: unknown): ConsentPollResult | undefined`
  - `buildConsentFragmentUrl(consentUrl: string, plaintext: string): string`

- [ ] **Step 1: Write the failing test** — `packages/core/src/consent-handoff.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff.test.ts`
Expected: FAIL — cannot find module `./consent-handoff.js`.

- [ ] **Step 3: Implement** — `packages/core/src/consent-handoff.ts`

```ts
export interface AuthRequiredConsent {
  consentUrl: string;
  pollUrl: string;
  expiresIn: number;
}

export type ConsentPollResult =
  | { status: "pending" }
  | { status: "approved"; receipt: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseAuthRequired(body: unknown): AuthRequiredConsent | undefined {
  const record = asRecord(body);
  if (record === undefined || record.status !== "auth_required") {
    return undefined;
  }
  const consent = asRecord(record.consent);
  if (
    consent === undefined ||
    typeof consent.consent_url !== "string" ||
    typeof consent.poll_url !== "string" ||
    typeof consent.expires_in !== "number"
  ) {
    return undefined;
  }
  return {
    consentUrl: consent.consent_url,
    pollUrl: consent.poll_url,
    expiresIn: consent.expires_in
  };
}

export function parseConsentStatus(body: unknown): ConsentPollResult | undefined {
  const record = asRecord(body);
  if (record === undefined) {
    return undefined;
  }
  if (record.status === "pending") {
    return { status: "pending" };
  }
  if (record.status === "approved" && typeof record.receipt === "string") {
    return { status: "approved", receipt: record.receipt };
  }
  return undefined;
}

export function buildConsentFragmentUrl(consentUrl: string, plaintext: string): string {
  return `${consentUrl}#${encodeURIComponent(plaintext)}`;
}
```

- [ ] **Step 4: Add exports** — in `packages/core/src/index.ts`, add:

```ts
export {
  parseAuthRequired,
  parseConsentStatus,
  buildConsentFragmentUrl
} from "./consent-handoff.js";
export type {
  AuthRequiredConsent,
  ConsentPollResult
} from "./consent-handoff.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/consent-handoff.ts packages/core/src/consent-handoff.test.ts packages/core/src/index.ts
git commit -m "feat(consent-handoff): wire-shape parsers + fragment URL builder"
```

---

### Task 2: `runConsentHandoff` — the pure orchestration loop

**Files:**
- Modify: `packages/core/src/consent-handoff.ts` (append the loop)
- Modify: `packages/core/src/consent-handoff.test.ts` (append tests)
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Consumes: `parseAuthRequired`, `buildConsentFragmentUrl` (Task 1).
- Produces:
  - `interface HandoffSubmitResponse { httpStatus: number; body: unknown }`
  - `interface RunConsentHandoffDeps { submit(consentReceiptToken?: string): Promise<HandoffSubmitResponse>; openConsentUrl(url: string): void | Promise<void>; pollConsent(pollUrl: string): Promise<ConsentPollResult>; sleep(ms: number): Promise<void> }`
  - `interface RunConsentHandoffOptions { plaintext: string; pollIntervalMs?: number; maxWaitMs?: number }`
  - `type RunConsentHandoffResult = { ok: true; body: unknown } | { ok: false; code: "consent_timeout" | "submit_failed"; detail?: unknown }`
  - `runConsentHandoff(deps: RunConsentHandoffDeps, options: RunConsentHandoffOptions): Promise<RunConsentHandoffResult>`

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/consent-handoff.test.ts`

```ts
import { runConsentHandoff, type HandoffSubmitResponse } from "./consent-handoff.js";

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
        openConsentUrl: (u) => { opened.push(u); },
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
        submit: async (token) => {
          submitCalls.push(token);
          return token === undefined
            ? authRequiredResponse()
            : { httpStatus: 202, body: { ok: true, status: "delivered", token } };
        },
        openConsentUrl: (u) => { opened.push(u); },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff.test.ts -t runConsentHandoff`
Expected: FAIL — `runConsentHandoff` is not exported.

- [ ] **Step 3: Implement** — append to `packages/core/src/consent-handoff.ts`

```ts
export interface HandoffSubmitResponse {
  httpStatus: number;
  body: unknown;
}

export interface RunConsentHandoffDeps {
  submit(consentReceiptToken?: string): Promise<HandoffSubmitResponse>;
  openConsentUrl(url: string): void | Promise<void>;
  pollConsent(pollUrl: string): Promise<ConsentPollResult>;
  sleep(ms: number): Promise<void>;
}

export interface RunConsentHandoffOptions {
  plaintext: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export type RunConsentHandoffResult =
  | { ok: true; body: unknown }
  | { ok: false; code: "consent_timeout" | "submit_failed"; detail?: unknown };

const defaultPollIntervalMs = 1500;
const defaultMaxWaitMs = 120000;

function isDelivered(httpStatus: number): boolean {
  return httpStatus >= 200 && httpStatus < 300;
}

export async function runConsentHandoff(
  deps: RunConsentHandoffDeps,
  options: RunConsentHandoffOptions
): Promise<RunConsentHandoffResult> {
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const maxWaitMs = options.maxWaitMs ?? defaultMaxWaitMs;

  const first = await deps.submit();
  if (isDelivered(first.httpStatus)) {
    return { ok: true, body: first.body };
  }
  const consent = first.httpStatus === 401 ? parseAuthRequired(first.body) : undefined;
  if (consent === undefined) {
    return { ok: false, code: "submit_failed", detail: first.body };
  }

  await deps.openConsentUrl(buildConsentFragmentUrl(consent.consentUrl, options.plaintext));

  let waited = 0;
  let receipt: string | undefined;
  // Poll first, then wait — so an already-approved consent resolves immediately.
  for (;;) {
    const status = await deps.pollConsent(consent.pollUrl);
    if (status.status === "approved") {
      receipt = status.receipt;
      break;
    }
    if (waited >= maxWaitMs) {
      return { ok: false, code: "consent_timeout" };
    }
    await deps.sleep(pollIntervalMs);
    waited += pollIntervalMs;
  }

  const second = await deps.submit(receipt);
  if (isDelivered(second.httpStatus)) {
    return { ok: true, body: second.body };
  }
  return { ok: false, code: "submit_failed", detail: second.body };
}
```

- [ ] **Step 4: Add exports** — in `packages/core/src/index.ts`, **replace the consent-handoff
  export block added in Task 1** with this expanded version (do not duplicate the value/type
  exports):

```ts
export {
  parseAuthRequired,
  parseConsentStatus,
  buildConsentFragmentUrl,
  runConsentHandoff
} from "./consent-handoff.js";
export type {
  AuthRequiredConsent,
  ConsentPollResult,
  HandoffSubmitResponse,
  RunConsentHandoffDeps,
  RunConsentHandoffOptions,
  RunConsentHandoffResult
} from "./consent-handoff.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/consent-handoff.ts packages/core/src/consent-handoff.test.ts packages/core/src/index.ts
git commit -m "feat(consent-handoff): pure submit→approve→resubmit orchestration loop"
```

---

### Task 3: Platform URL opener

**Files:**
- Create: `packages/core/src/consent-handoff-runtime.ts`
- Create: `packages/core/src/consent-handoff-runtime.test.ts`
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Produces:
  - `interface OpenCommand { command: string; args(url: string): string[] }`
  - `resolveOpenCommand(platform: NodeJS.Platform): OpenCommand`
  - `defaultOpenUrl(url: string): void` (uses `resolveOpenCommand(process.platform)` + `node:child_process` spawn)

- [ ] **Step 1: Write the failing test** — `packages/core/src/consent-handoff-runtime.test.ts`

```ts
import { describe, expect, test } from "vitest";
import { resolveOpenCommand } from "./consent-handoff-runtime.js";

describe("resolveOpenCommand", () => {
  test("test_macos_uses_open", () => {
    const c = resolveOpenCommand("darwin");
    expect(c.command).toBe("open");
    expect(c.args("https://x")).toEqual(["https://x"]);
  });

  test("test_windows_uses_cmd_start", () => {
    const c = resolveOpenCommand("win32");
    expect(c.command).toBe("cmd");
    expect(c.args("https://x")).toEqual(["/c", "start", "", "https://x"]);
  });

  test("test_linux_uses_xdg_open", () => {
    const c = resolveOpenCommand("linux");
    expect(c.command).toBe("xdg-open");
    expect(c.args("https://x")).toEqual(["https://x"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff-runtime.test.ts`
Expected: FAIL — cannot find module `./consent-handoff-runtime.js`.

- [ ] **Step 3: Implement** — `packages/core/src/consent-handoff-runtime.ts`

```ts
import { spawn } from "node:child_process";

export interface OpenCommand {
  command: string;
  args(url: string): string[];
}

export function resolveOpenCommand(platform: NodeJS.Platform): OpenCommand {
  if (platform === "darwin") {
    return { command: "open", args: (url) => [url] };
  }
  if (platform === "win32") {
    // Empty "" is the required title argument for `start`.
    return { command: "cmd", args: (url) => ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: (url) => [url] };
}

export function defaultOpenUrl(url: string): void {
  const { command, args } = resolveOpenCommand(process.platform);
  const child = spawn(command, args(url), { stdio: "ignore", detached: true });
  child.unref();
}
```

- [ ] **Step 4: Add exports** — in `packages/core/src/index.ts`, add:

```ts
export {
  resolveOpenCommand,
  defaultOpenUrl
} from "./consent-handoff-runtime.js";
export type { OpenCommand } from "./consent-handoff-runtime.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff-runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/consent-handoff-runtime.ts packages/core/src/consent-handoff-runtime.test.ts packages/core/src/index.ts
git commit -m "feat(consent-handoff): platform URL opener (open/xdg-open/cmd start)"
```

---

### Task 4: `submitWithConsent` runtime assembly

**Files:**
- Modify: `packages/core/src/consent-handoff-runtime.ts` (append the adapter)
- Modify: `packages/core/src/consent-handoff-runtime.test.ts` (append tests)
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Consumes: `runConsentHandoff`, `parseConsentStatus`, `RunConsentHandoffResult`, `HandoffSubmitResponse`, `ConsentPollResult` (Tasks 1–2); `defaultOpenUrl` (Task 3).
- Produces:
  - `interface SubmitWithConsentInput { submitUrl: string; envelope: unknown; plaintext: string; withReceipt(envelope: unknown, consentReceiptToken: string): unknown; fetchImpl?: typeof fetch; openImpl?(url: string): void; sleepImpl?(ms: number): Promise<void>; print?(message: string): void; autoOpen?: boolean; pollIntervalMs?: number; maxWaitMs?: number }`
  - `submitWithConsent(input: SubmitWithConsentInput): Promise<RunConsentHandoffResult>`

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/consent-handoff-runtime.test.ts`

```ts
import { submitWithConsent } from "./consent-handoff-runtime.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff-runtime.test.ts -t submitWithConsent`
Expected: FAIL — `submitWithConsent` is not exported.

- [ ] **Step 3: Implement** — add this import at the **top** of
  `packages/core/src/consent-handoff-runtime.ts` (directly below the existing
  `import { spawn } from "node:child_process";`), then append the rest below the Task 3 code:

```ts
import {
  parseConsentStatus,
  runConsentHandoff,
  type ConsentPollResult,
  type HandoffSubmitResponse,
  type RunConsentHandoffResult
} from "./consent-handoff.js";

export interface SubmitWithConsentInput {
  submitUrl: string;
  /** The caller's already-encrypted A2A submission body. */
  envelope: unknown;
  /** Plaintext for the consent page — only ever placed in the URL fragment. */
  plaintext: string;
  /** Attach the minted consent receipt token to the envelope for resubmission. */
  withReceipt(envelope: unknown, consentReceiptToken: string): unknown;
  fetchImpl?: typeof fetch;
  openImpl?(url: string): void;
  sleepImpl?(ms: number): Promise<void>;
  print?(message: string): void;
  autoOpen?: boolean;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function submitWithConsent(
  input: SubmitWithConsentInput
): Promise<RunConsentHandoffResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = input.print ?? ((message: string) => console.log(message));
  const autoOpen = input.autoOpen ?? true;

  const submit = async (token?: string): Promise<HandoffSubmitResponse> => {
    const envelope = token === undefined ? input.envelope : input.withReceipt(input.envelope, token);
    const response = await fetchImpl(input.submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    return { httpStatus: response.status, body: await readJson(response) };
  };

  const openConsentUrl = (url: string): void => {
    // Always surface the URL (source of truth); auto-open is best-effort.
    print(`Approve this submission in your browser: ${url}`);
    if (autoOpen) {
      const open = input.openImpl ?? defaultOpenUrl;
      try {
        open(url);
      } catch {
        // Printing already gave the user a way through; opening is a convenience.
      }
    }
  };

  const pollConsent = async (pollUrl: string): Promise<ConsentPollResult> => {
    const response = await fetchImpl(pollUrl, { method: "GET" });
    return parseConsentStatus(await readJson(response)) ?? { status: "pending" };
  };

  return runConsentHandoff(
    { submit, openConsentUrl, pollConsent, sleep },
    {
      plaintext: input.plaintext,
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(input.maxWaitMs !== undefined ? { maxWaitMs: input.maxWaitMs } : {})
    }
  );
}
```

- [ ] **Step 4: Add exports** — in `packages/core/src/index.ts`, add:

```ts
export { submitWithConsent } from "./consent-handoff-runtime.js";
export type { SubmitWithConsentInput } from "./consent-handoff-runtime.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @watasu/core exec vitest run src/consent-handoff-runtime.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 6: Full green gate**

Run: `pnpm test`
Expected: typecheck clean; all tests pass; 0 new failures vs the 456 baseline.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/consent-handoff-runtime.ts packages/core/src/consent-handoff-runtime.test.ts packages/core/src/index.ts
git commit -m "feat(consent-handoff): submitWithConsent runtime adapter (fetch + open + poll)"
```

---

## Notes for the implementer

- **The plaintext boundary is the whole point.** `plaintext` flows *only* into
  `buildConsentFragmentUrl` → the opener. It is never serialized into a submit/poll body. Task 4
  Step 1 has an explicit regression test (`test_plaintext_never_enters_submit_body`) — keep it.
- **`withReceipt` is intentionally injected** rather than hard-coding where `consent_receipt_token`
  goes, because the exact envelope shape (`message.parts[0].data.consent_receipt_token`) is the
  caller's concern. A real CLI wrapper will pass a `withReceipt` that sets that path.
- **Out of scope for this plan** (later increments): a `watasu submit --wait` CLI command that
  builds and encrypts a real envelope; Path A (WebMCP tool surface); Path C (human-enters). This
  plan delivers the reusable Path B loop those will call.
- **`fetch` is global on Node ≥22**, so no dependency is needed for the default `fetchImpl`.
