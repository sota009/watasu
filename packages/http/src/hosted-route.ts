export function decodeHostedRequestIdSegment(encodedValue: string | undefined): string | undefined {
  if (encodedValue === undefined) {
    return undefined;
  }

  try {
    const requestId = decodeURIComponent(encodedValue);
    return isHostedRequestId(requestId) ? requestId : undefined;
  } catch {
    return undefined;
  }
}

function isHostedRequestId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}
