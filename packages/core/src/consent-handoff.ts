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
    typeof consent.expires_in !== "number" ||
    !Number.isFinite(consent.expires_in)
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
// Ultimate fallback only: normally the server's advertised consent.expiresIn wins (see below).
const defaultMaxWaitMs = 600000;

function isDelivered(httpStatus: number): boolean {
  return httpStatus >= 200 && httpStatus < 300;
}

export async function runConsentHandoff(
  deps: RunConsentHandoffDeps,
  options: RunConsentHandoffOptions
): Promise<RunConsentHandoffResult> {
  // Guard against a zero (or negative) interval, which would leave `waited` stuck and loop forever.
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? defaultPollIntervalMs);

  const first = await deps.submit();
  if (isDelivered(first.httpStatus)) {
    return { ok: true, body: first.body };
  }
  const consent = first.httpStatus === 401 ? parseAuthRequired(first.body) : undefined;
  if (consent === undefined) {
    return { ok: false, code: "submit_failed", detail: first.body };
  }

  // Default the wait bound to the server's advertised consent window (consent.expiresIn) so a
  // slow-to-approve user isn't cut off while the consent is still valid server-side. Only fall
  // back to defaultMaxWaitMs when the server didn't give us a usable (positive) window.
  const maxWaitMs = options.maxWaitMs ?? (consent.expiresIn > 0 ? consent.expiresIn * 1000 : defaultMaxWaitMs);

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
