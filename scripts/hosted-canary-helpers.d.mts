export const hostedCanaryRequiredHeaders: Record<string, string>;

export function parseHostedCanaryBaseUrl(rawBaseUrl: string | undefined): URL;

export function resolveHostedCanaryBaseUrl(input: {
  env: Record<string, string | undefined>;
  argv: string[];
}): URL;
