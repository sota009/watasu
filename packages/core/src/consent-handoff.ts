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
