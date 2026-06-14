export const hostedCanaryRequiredHeaders: Record<string, string>;
export const hostedCanaryUnpublishedRequestId: string;

export function buildHostedCanaryCheckUrls(baseUrl: URL): {
  health: string;
  unpublishedAgentCard: string;
  unpublishedSubmit: string;
};

export function parseHostedCanaryBaseUrl(rawBaseUrl: string | undefined): URL;

export function resolveHostedCanaryBaseUrl(input: {
  env: Record<string, string | undefined>;
  argv: string[];
}): URL;
