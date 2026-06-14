import { createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { RequestDefinition } from "./request-definition.js";
import { InMemoryRequestVersionRepository } from "./request-version.js";
import { publishRequestVersion } from "./publish.js";
import {
  InMemoryOwnershipChallengeRegistry,
  buildOwnershipVerification
} from "./ownership.js";

const now = new Date("2026-06-14T12:00:00.000Z");

const baseDefinition: RequestDefinition = {
  name: "event-attendee-intake",
  schema_version: "2026-06-14",
  description: "Collect attendee details for ExampleConf.",
  fields: [
    {
      id: "email",
      type: "string",
      required: true,
      purpose: "Send event updates.",
      sensitivity: "moderate"
    }
  ],
  consent: {
    text: "ExampleConf uses this information only for event operations."
  },
  destination: {
    type: "webhook",
    url: "https://receiver.example.com/watasu/intake"
  },
  retention: {
    destination_policy: "Delete within 30 days after the event."
  },
  encryption: {
    mode: "required",
    algorithm: "JWE",
    key_management: "ECDH-ES+A256KW",
    content_encryption: "A256GCM",
    service_key_id: "jwk-thumbprint:sha256:service",
    public_key_jwk: {
      kty: "EC",
      crv: "P-256",
      x: "base64url-x",
      y: "base64url-y"
    }
  },
  metadata_retention: {
    days: 90
  },
  trust_profile: "verified_sender"
};

function createServiceKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  });

  return {
    privateJwk: privateKey.export({ format: "jwk" }),
    publicJwk: publicKey.export({ format: "jwk" })
  };
}

function signChallenge(challengeText: string, privateJwk: JsonWebKey): string {
  return sign("sha256", Buffer.from(challengeText, "utf8"), {
    key: createPrivateKey({ key: privateJwk, format: "jwk" }),
    dsaEncoding: "ieee-p1363"
  }).toString("base64url");
}

describe("ownership challenge lifecycle", () => {
  test("test_service_key_challenge_verifies_private_key_ownership", () => {
    // Arrange
    const keys = createServiceKeyPair();
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-key-001",
      generateChallengeSecret: () => "secret-key-001"
    });
    const challenge = registry.issueServiceKeyChallenge({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      public_jwk: keys.publicJwk,
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = registry.verifyServiceKeyChallenge({
      challenge_id: challenge.challenge_id,
      signature: signChallenge(challenge.challenge_text, keys.privateJwk)
    });

    // Assert
    expect(result).toMatchObject({
      ok: true,
      service_key_id: "jwk-thumbprint:sha256:service"
    });
    expect(registry.listVerifiedServiceKeyIds("tenant-a")).toEqual([
      "jwk-thumbprint:sha256:service"
    ]);
  });

  test("test_service_key_challenge_rejects_wrong_signature", () => {
    // Arrange
    const keys = createServiceKeyPair();
    const wrongKeys = createServiceKeyPair();
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-key-001",
      generateChallengeSecret: () => "secret-key-001"
    });
    const challenge = registry.issueServiceKeyChallenge({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      public_jwk: keys.publicJwk,
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = registry.verifyServiceKeyChallenge({
      challenge_id: challenge.challenge_id,
      signature: signChallenge(challenge.challenge_text, wrongKeys.privateJwk)
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "challenge_signature_invalid"
      }
    });
    expect(registry.listVerifiedServiceKeyIds("tenant-a")).toEqual([]);
  });

  test("test_webhook_origin_challenge_verifies_expected_token", () => {
    // Arrange
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    const challenge = registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = registry.verifyWebhookOriginChallenge({
      challenge_id: challenge.challenge_id,
      observed_token: challenge.expected_token
    });

    // Assert
    expect(result).toMatchObject({
      ok: true,
      origin: "https://receiver.example.com"
    });
    expect(registry.listVerifiedWebhookOrigins("tenant-a")).toEqual([
      "https://receiver.example.com"
    ]);
  });

  test("test_webhook_origin_challenge_fetches_https_well_known_token", async () => {
    // Arrange
    const fetchedUrls: string[] = [];
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = await registry.verifyWebhookOriginChallengeFromHttps({
      challenge_id: "challenge-webhook-001",
      resolveHost: async () => ["203.0.113.10"],
      fetch: async (url, init) => {
        fetchedUrls.push(url);
        expect(init.redirect).toBe("manual");
        return {
          status: 200,
          text: async () => "secret-webhook-001"
        };
      }
    });

    // Assert
    expect(result).toMatchObject({
      ok: true,
      origin: "https://receiver.example.com"
    });
    expect(fetchedUrls).toEqual([
      "https://receiver.example.com/.well-known/watasu-webhook-challenge/challenge-webhook-001"
    ]);
    expect(registry.listVerifiedWebhookOrigins("tenant-a")).toEqual([
      "https://receiver.example.com"
    ]);
  });

  test("test_webhook_origin_challenge_fetch_rejects_non_https_origin", async () => {
    // Arrange
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "http://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = await registry.verifyWebhookOriginChallengeFromHttps({
      challenge_id: "challenge-webhook-001",
      resolveHost: async () => ["203.0.113.10"],
      fetch: async () => {
        throw new Error("fetch must not run");
      }
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_challenge_url"
      }
    });
    expect(registry.listVerifiedWebhookOrigins("tenant-a")).toEqual([]);
  });

  test("test_webhook_origin_challenge_fetch_rejects_private_dns_result", async () => {
    // Arrange
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = await registry.verifyWebhookOriginChallengeFromHttps({
      challenge_id: "challenge-webhook-001",
      resolveHost: async () => ["169.254.169.254"],
      fetch: async () => {
        throw new Error("fetch must not run");
      }
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_challenge_host"
      }
    });
    expect(registry.listVerifiedWebhookOrigins("tenant-a")).toEqual([]);
  });

  test("test_webhook_origin_challenge_fetch_rejects_token_mismatch", async () => {
    // Arrange
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = await registry.verifyWebhookOriginChallengeFromHttps({
      challenge_id: "challenge-webhook-001",
      resolveHost: async () => ["203.0.113.10"],
      fetch: async () => ({
        status: 200,
        text: async () => "wrong-token"
      })
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "challenge_token_mismatch"
      }
    });
    expect(registry.listVerifiedWebhookOrigins("tenant-a")).toEqual([]);
  });

  test("test_webhook_origin_challenge_verifies_dns_txt_token", async () => {
    // Arrange
    const resolvedNames: string[] = [];
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = await registry.verifyWebhookOriginChallengeFromDnsTxt({
      challenge_id: "challenge-webhook-001",
      resolveTxt: async (name) => {
        resolvedNames.push(name);
        return [["secret-webhook-", "001"]];
      }
    });

    // Assert
    expect(result).toMatchObject({
      ok: true,
      origin: "https://receiver.example.com"
    });
    expect(resolvedNames).toEqual([
      "_watasu-challenge.receiver.example.com"
    ]);
    expect(registry.listVerifiedWebhookOrigins("tenant-a")).toEqual([
      "https://receiver.example.com"
    ]);
  });

  test("test_webhook_origin_challenge_dns_txt_rejects_token_mismatch", async () => {
    // Arrange
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = await registry.verifyWebhookOriginChallengeFromDnsTxt({
      challenge_id: "challenge-webhook-001",
      resolveTxt: async () => [["wrong-token"]]
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "challenge_token_mismatch"
      }
    });
    expect(registry.listVerifiedWebhookOrigins("tenant-a")).toEqual([]);
  });

  test("test_webhook_origin_challenge_dns_txt_returns_fetch_error_when_lookup_fails", async () => {
    // Arrange
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => "challenge-webhook-001",
      generateChallengeSecret: () => "secret-webhook-001"
    });
    registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });

    // Act
    const result = await registry.verifyWebhookOriginChallengeFromDnsTxt({
      challenge_id: "challenge-webhook-001",
      resolveTxt: async () => {
        throw new Error("DNS unavailable");
      }
    });

    // Assert
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "challenge_dns_txt_fetch_failed"
      }
    });
  });

  test("test_verified_challenges_build_publish_ownership_state", () => {
    // Arrange
    const keys = createServiceKeyPair();
    let challengeCount = 0;
    const registry = new InMemoryOwnershipChallengeRegistry({
      clock: () => now,
      generateChallengeId: () => {
        challengeCount += 1;
        return `challenge-00${challengeCount}`;
      },
      generateChallengeSecret: () => "secret-001"
    });
    const keyChallenge = registry.issueServiceKeyChallenge({
      tenant_id: "tenant-a",
      service_key_id: "jwk-thumbprint:sha256:service",
      public_jwk: keys.publicJwk,
      expires_at: "2026-06-14T12:05:00.000Z"
    });
    registry.verifyServiceKeyChallenge({
      challenge_id: keyChallenge.challenge_id,
      signature: signChallenge(keyChallenge.challenge_text, keys.privateJwk)
    });
    const webhookChallenge = registry.issueWebhookOriginChallenge({
      tenant_id: "tenant-a",
      origin: "https://receiver.example.com",
      expires_at: "2026-06-14T12:05:00.000Z"
    });
    registry.verifyWebhookOriginChallenge({
      challenge_id: webhookChallenge.challenge_id,
      observed_token: webhookChallenge.expected_token
    });

    // Act
    const result = publishRequestVersion({
      requestId: "event-attendee-intake",
      definition: {
        ...baseDefinition,
        encryption: {
          ...baseDefinition.encryption,
          public_key_jwk: keys.publicJwk
        }
      },
      confirmed: true,
      mode: "hosted",
      repository: new InMemoryRequestVersionRepository(),
      ownership: buildOwnershipVerification({
        tenant_id: "tenant-a",
        registry
      })
    });

    // Assert
    expect(result).toMatchObject({
      ok: true,
      published: {
        request_id: "event-attendee-intake"
      }
    });
  });
});
