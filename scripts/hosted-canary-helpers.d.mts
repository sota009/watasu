export const hostedCanaryRequiredHeaders: Record<string, string>;
export const hostedCanaryUnpublishedRequestId: string;
export const defaultHostedCanaryTimeoutMs: number;
export const maxHostedCanaryTimeoutMs: number;

export function buildHostedCanaryCheckUrls(baseUrl: URL): {
  health: string;
  unpublishedAgentCard: string;
  unpublishedPlaintextSchema: string;
  unpublishedEnvelopeSchema: string;
  unpublishedSubmit: string;
  mcpEndpoint: string;
  mcpProtectedResourceMetadata: string;
  unsafeEncodedRequestId: string;
};

export function buildHostedCanarySuccessReport(input: {
  status: number;
  timeoutMs: number;
  urls: ReturnType<typeof buildHostedCanaryCheckUrls>;
}): {
  ok: true;
  checked_url: string;
  checked_public_routes: string[];
  checked_headers: string[];
  checked_timeout_ms: number;
  status: number;
};

export function parseHostedCanaryBaseUrl(rawBaseUrl: string | undefined): URL;

export function resolveHostedCanaryBaseUrl(input: {
  env: Record<string, string | undefined>;
  argv: string[];
}): URL;

export function resolveHostedCanaryTimeoutMs(env: Record<string, string | undefined>): number;

export function withHostedCanaryTimeout(
  init: RequestInit,
  timeoutMs: number
): RequestInit;

export function formatHostedCanaryRequestError(label: string, error: unknown): string;

export function formatHostedCanaryResponseReadError(label: string, error: unknown): string;
