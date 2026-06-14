import {
  exportJWK,
  generateKeyPair
} from "jose";
import { describe, expect, test } from "vitest";
import {
  decryptJsonPayload,
  encryptJsonPayload,
  type WatasuFlattenedJwe
} from "./jwe.js";

async function createJwkPair() {
  const keyPair = await generateKeyPair("ECDH-ES+A256KW", {
    extractable: true
  });

  return {
    publicJwk: await exportJWK(keyPair.publicKey),
    privateJwk: await exportJWK(keyPair.privateKey)
  };
}

describe("JWE JSON payload encryption", () => {
  test("test_jwe_encrypts_and_decrypts_json_payload", async () => {
    const keys = await createJwkPair();

    const encrypted = await encryptJsonPayload({
      payload: {
        full_name: "Alice Example",
        email: "alice@example.test"
      },
      publicJwk: keys.publicJwk,
      serviceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    });

    expect(JSON.stringify(encrypted)).not.toContain("Alice Example");
    expect(JSON.stringify(encrypted)).not.toContain("alice@example.test");
    expect(encrypted).toMatchObject({
      protected: expect.any(String),
      iv: expect.any(String),
      ciphertext: expect.any(String),
      tag: expect.any(String)
    });

    await expect(decryptJsonPayload({
      encryptedPayload: encrypted,
      privateJwk: keys.privateJwk,
      expectedServiceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    })).resolves.toEqual({
      full_name: "Alice Example",
      email: "alice@example.test"
    });
  });

  test("test_jwe_rejects_unsupported_algorithm_before_encrypting", async () => {
    const keys = await createJwkPair();

    await expect(encryptJsonPayload({
      payload: {
        full_name: "Alice Example"
      },
      publicJwk: keys.publicJwk,
      serviceKeyId: "jwk-thumbprint:sha256:test",
      alg: "dir",
      enc: "A256GCM"
    })).rejects.toThrow("Unsupported JWE alg");
  });

  test("test_jwe_rejects_unsupported_content_encryption_before_encrypting", async () => {
    const keys = await createJwkPair();

    await expect(encryptJsonPayload({
      payload: {
        full_name: "Alice Example"
      },
      publicJwk: keys.publicJwk,
      serviceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A128CBC-HS256"
    })).rejects.toThrow("Unsupported JWE enc");
  });

  test("test_jwe_decrypt_rejects_wrong_private_key", async () => {
    const keys = await createJwkPair();
    const wrongKeys = await createJwkPair();
    const encrypted = await encryptJsonPayload({
      payload: {
        full_name: "Alice Example"
      },
      publicJwk: keys.publicJwk,
      serviceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    });

    await expect(decryptJsonPayload({
      encryptedPayload: encrypted,
      privateJwk: wrongKeys.privateJwk,
      expectedServiceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    })).rejects.toThrow();
  });

  test("test_jwe_decrypt_rejects_tampered_ciphertext", async () => {
    const keys = await createJwkPair();
    const encrypted = await encryptJsonPayload({
      payload: {
        full_name: "Alice Example"
      },
      publicJwk: keys.publicJwk,
      serviceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    });
    const tampered: WatasuFlattenedJwe = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -1)}A`
    };

    await expect(decryptJsonPayload({
      encryptedPayload: tampered,
      privateJwk: keys.privateJwk,
      expectedServiceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    })).rejects.toThrow();
  });

  test("test_jwe_decrypt_rejects_service_key_id_mismatch", async () => {
    const keys = await createJwkPair();
    const encrypted = await encryptJsonPayload({
      payload: {
        full_name: "Alice Example"
      },
      publicJwk: keys.publicJwk,
      serviceKeyId: "jwk-thumbprint:sha256:test",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    });

    await expect(decryptJsonPayload({
      encryptedPayload: encrypted,
      privateJwk: keys.privateJwk,
      expectedServiceKeyId: "jwk-thumbprint:sha256:other",
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM"
    })).rejects.toThrow("JWE kid does not match");
  });
});
