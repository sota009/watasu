import { createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
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

function verificationError(code: string, message: string): OwnershipChallengeVerificationResult {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}
