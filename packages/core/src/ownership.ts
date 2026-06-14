import { createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { lookup, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import type { PublishOwnershipVerification } from "./publish.js";

export type OwnershipChallengeStatus = "pending" | "verified" | "expired";

export interface ServiceKeyOwnershipChallenge {
  kind: "service_key";
  tenant_id: string;
  challenge_id: string;
  service_key_id: string;
  public_jwk: JsonWebKey;
  challenge_text: string;
  status: OwnershipChallengeStatus;
  issued_at: string;
  expires_at: string;
  verified_at?: string | undefined;
}

export interface WebhookOriginOwnershipChallenge {
  kind: "webhook_origin";
  tenant_id: string;
  challenge_id: string;
  origin: string;
  expected_token: string;
  well_known_path: string;
  status: OwnershipChallengeStatus;
  issued_at: string;
  expires_at: string;
  verified_at?: string | undefined;
}

export type OwnershipChallenge =
  | ServiceKeyOwnershipChallenge
  | WebhookOriginOwnershipChallenge;

export type OwnershipChallengeVerificationResult =
  | {
      ok: true;
      tenant_id: string;
      service_key_id?: string | undefined;
      origin?: string | undefined;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export type WebhookOwnershipChallengeFetch = (
  input: string,
  init: {
    method: "GET";
    redirect: "manual";
    signal: AbortSignal;
    headers: Record<string, string>;
  }
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export type WebhookOwnershipChallengeHostResolver = (
  hostname: string
) => Promise<string[]>;

export type WebhookOwnershipChallengeTxtResolver = (
  name: string
) => Promise<string[][]>;

export class InMemoryOwnershipChallengeRegistry {
  readonly #challengesById = new Map<string, OwnershipChallenge>();
  readonly #clock: () => Date;
  readonly #generateChallengeId: () => string;
  readonly #generateChallengeSecret: () => string;

  constructor(input: {
    clock: () => Date;
    generateChallengeId?: (() => string) | undefined;
    generateChallengeSecret?: (() => string) | undefined;
  }) {
    this.#clock = input.clock;
    this.#generateChallengeId = input.generateChallengeId ?? (() => randomBytes(16).toString("base64url"));
    this.#generateChallengeSecret = input.generateChallengeSecret ?? (() => randomBytes(32).toString("base64url"));
  }

  issueServiceKeyChallenge(input: {
    tenant_id: string;
    service_key_id: string;
    public_jwk: JsonWebKey;
    expires_at: string;
  }): ServiceKeyOwnershipChallenge {
    const challenge: ServiceKeyOwnershipChallenge = {
      kind: "service_key",
      tenant_id: input.tenant_id,
      challenge_id: this.#generateChallengeId(),
      service_key_id: input.service_key_id,
      public_jwk: input.public_jwk,
      challenge_text: [
        "watasu-service-key-ownership-v1",
        input.tenant_id,
        input.service_key_id,
        this.#generateChallengeSecret()
      ].join("\n"),
      status: "pending",
      issued_at: this.#clock().toISOString(),
      expires_at: input.expires_at
    };
    this.#challengesById.set(challenge.challenge_id, challenge);

    return structuredClone(challenge);
  }

  verifyServiceKeyChallenge(input: {
    challenge_id: string;
    signature: string;
  }): OwnershipChallengeVerificationResult {
    const challenge = this.#challengesById.get(input.challenge_id);
    if (challenge?.kind !== "service_key") {
      return verificationError("challenge_not_found", "Ownership challenge was not found.");
    }

    if (isExpired(challenge.expires_at, this.#clock())) {
      this.#challengesById.set(challenge.challenge_id, {
        ...challenge,
        status: "expired"
      });
      return verificationError("challenge_expired", "Ownership challenge has expired.");
    }

    const signatureValid = verifyServiceKeySignature(challenge, input.signature);
    if (!signatureValid) {
      return verificationError("challenge_signature_invalid", "Ownership challenge signature is invalid.");
    }

    this.#challengesById.set(challenge.challenge_id, {
      ...challenge,
      status: "verified",
      verified_at: this.#clock().toISOString()
    });

    return {
      ok: true,
      tenant_id: challenge.tenant_id,
      service_key_id: challenge.service_key_id
    };
  }

  issueWebhookOriginChallenge(input: {
    tenant_id: string;
    origin: string;
    expires_at: string;
  }): WebhookOriginOwnershipChallenge {
    const challengeId = this.#generateChallengeId();
    const expectedToken = this.#generateChallengeSecret();
    const challenge: WebhookOriginOwnershipChallenge = {
      kind: "webhook_origin",
      tenant_id: input.tenant_id,
      challenge_id: challengeId,
      origin: new URL(input.origin).origin,
      expected_token: expectedToken,
      well_known_path: `/.well-known/watasu-webhook-challenge/${challengeId}`,
      status: "pending",
      issued_at: this.#clock().toISOString(),
      expires_at: input.expires_at
    };
    this.#challengesById.set(challenge.challenge_id, challenge);

    return structuredClone(challenge);
  }

  verifyWebhookOriginChallenge(input: {
    challenge_id: string;
    observed_token: string;
  }): OwnershipChallengeVerificationResult {
    const challenge = this.#challengesById.get(input.challenge_id);
    if (challenge?.kind !== "webhook_origin") {
      return verificationError("challenge_not_found", "Ownership challenge was not found.");
    }

    if (isExpired(challenge.expires_at, this.#clock())) {
      this.#challengesById.set(challenge.challenge_id, {
        ...challenge,
        status: "expired"
      });
      return verificationError("challenge_expired", "Ownership challenge has expired.");
    }

    if (input.observed_token !== challenge.expected_token) {
      return verificationError("challenge_token_mismatch", "Webhook origin challenge token did not match.");
    }

    this.#challengesById.set(challenge.challenge_id, {
      ...challenge,
      status: "verified",
      verified_at: this.#clock().toISOString()
    });

    return {
      ok: true,
      tenant_id: challenge.tenant_id,
      origin: challenge.origin
    };
  }

  async verifyWebhookOriginChallengeFromHttps(input: {
    challenge_id: string;
    fetch?: WebhookOwnershipChallengeFetch | undefined;
    resolveHost?: WebhookOwnershipChallengeHostResolver | undefined;
    timeoutMs?: number | undefined;
  }): Promise<OwnershipChallengeVerificationResult> {
    const challenge = this.#challengesById.get(input.challenge_id);
    if (challenge?.kind !== "webhook_origin") {
      return verificationError("challenge_not_found", "Ownership challenge was not found.");
    }

    if (isExpired(challenge.expires_at, this.#clock())) {
      this.#challengesById.set(challenge.challenge_id, {
        ...challenge,
        status: "expired"
      });
      return verificationError("challenge_expired", "Ownership challenge has expired.");
    }

    const originUrl = new URL(challenge.origin);
    if (originUrl.protocol !== "https:") {
      return verificationError("unsafe_challenge_url", "Webhook ownership challenge fetch requires HTTPS.");
    }

    const resolveHost = input.resolveHost ?? resolvePublicHost;
    const addresses = await resolveHost(originUrl.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateOrMetadataAddress)) {
      return verificationError(
        "unsafe_challenge_host",
        "Webhook ownership challenge host resolved to an unsafe address."
      );
    }

    const fetchImplementation = input.fetch ?? defaultWebhookOwnershipChallengeFetch;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), input.timeoutMs ?? 5_000);

    try {
      const response = await fetchImplementation(`${challenge.origin}${challenge.well_known_path}`, {
        method: "GET",
        redirect: "manual",
        signal: abortController.signal,
        headers: {
          accept: "text/plain"
        }
      });
      if (response.status < 200 || response.status >= 300) {
        return verificationError("challenge_fetch_failed", "Webhook ownership challenge token could not be fetched.");
      }

      return this.verifyWebhookOriginChallenge({
        challenge_id: challenge.challenge_id,
        observed_token: (await response.text()).trim()
      });
    } catch {
      return verificationError("challenge_fetch_failed", "Webhook ownership challenge token could not be fetched.");
    } finally {
      clearTimeout(timeout);
    }
  }

  async verifyWebhookOriginChallengeFromDnsTxt(input: {
    challenge_id: string;
    resolveTxt?: WebhookOwnershipChallengeTxtResolver | undefined;
  }): Promise<OwnershipChallengeVerificationResult> {
    const challenge = this.#challengesById.get(input.challenge_id);
    if (challenge?.kind !== "webhook_origin") {
      return verificationError("challenge_not_found", "Ownership challenge was not found.");
    }

    if (isExpired(challenge.expires_at, this.#clock())) {
      this.#challengesById.set(challenge.challenge_id, {
        ...challenge,
        status: "expired"
      });
      return verificationError("challenge_expired", "Ownership challenge has expired.");
    }

    const txtName = `_watasu-challenge.${new URL(challenge.origin).hostname}`;
    const resolveTxtImplementation = input.resolveTxt ?? defaultWebhookOwnershipChallengeTxtResolve;

    try {
      const records = await resolveTxtImplementation(txtName);
      const observedTokens = records.map((chunks) => chunks.join("").trim());
      if (!observedTokens.includes(challenge.expected_token)) {
        return verificationError("challenge_token_mismatch", "Webhook origin challenge token did not match.");
      }

      return this.verifyWebhookOriginChallenge({
        challenge_id: challenge.challenge_id,
        observed_token: challenge.expected_token
      });
    } catch {
      return verificationError(
        "challenge_dns_txt_fetch_failed",
        "Webhook ownership challenge DNS TXT record could not be fetched."
      );
    }
  }

  listVerifiedServiceKeyIds(tenantId: string): string[] {
    return [...this.#challengesById.values()]
      .filter((challenge): challenge is ServiceKeyOwnershipChallenge =>
        challenge.kind === "service_key" &&
        challenge.tenant_id === tenantId &&
        challenge.status === "verified"
      )
      .map((challenge) => challenge.service_key_id);
  }

  listVerifiedWebhookOrigins(tenantId: string): string[] {
    return [...this.#challengesById.values()]
      .filter((challenge): challenge is WebhookOriginOwnershipChallenge =>
        challenge.kind === "webhook_origin" &&
        challenge.tenant_id === tenantId &&
        challenge.status === "verified"
      )
      .map((challenge) => challenge.origin);
  }
}

export function buildOwnershipVerification(input: {
  tenant_id: string;
  registry: InMemoryOwnershipChallengeRegistry;
}): PublishOwnershipVerification {
  return {
    verifiedServiceKeyIds: input.registry.listVerifiedServiceKeyIds(input.tenant_id),
    verifiedWebhookOrigins: input.registry.listVerifiedWebhookOrigins(input.tenant_id)
  };
}

function verifyServiceKeySignature(
  challenge: ServiceKeyOwnershipChallenge,
  signature: string
): boolean {
  try {
    return verify("sha256", Buffer.from(challenge.challenge_text, "utf8"), {
      key: createPublicKey({ key: challenge.public_jwk, format: "jwk" }),
      dsaEncoding: "ieee-p1363"
    }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function isExpired(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

async function resolvePublicHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, {
    all: true
  });
  return records.map((record) => record.address);
}

async function defaultWebhookOwnershipChallengeFetch(
  input: string,
  init: {
    method: "GET";
    redirect: "manual";
    signal: AbortSignal;
    headers: Record<string, string>;
  }
): Promise<{
  status: number;
  text(): Promise<string>;
}> {
  return fetch(input, init);
}

async function defaultWebhookOwnershipChallengeTxtResolve(name: string): Promise<string[][]> {
  return resolveTxt(name);
}

function isPrivateOrMetadataAddress(address: string): boolean {
  const normalizedAddress = address.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const ipVersion = isIP(normalizedAddress);
  if (ipVersion === 0) {
    return true;
  }

  if (ipVersion === 6) {
    return (
      normalizedAddress === "::1" ||
      normalizedAddress.startsWith("fc") ||
      normalizedAddress.startsWith("fd") ||
      normalizedAddress.startsWith("fe80:")
    );
  }

  const [first = 0, second = 0] = normalizedAddress.split(".").map((part) => Number(part));
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function verificationError(code: string, message: string): OwnershipChallengeVerificationResult {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}
