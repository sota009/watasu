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
