import {
  FlattenedEncrypt,
  flattenedDecrypt,
  importJWK,
  type FlattenedJWE,
  type JWK
} from "jose";

export type WatasuJweAlgorithm = "ECDH-ES+A256KW";
export type WatasuJweContentEncryption = "A256GCM";

export interface WatasuFlattenedJwe {
  protected: string;
  iv: string;
  ciphertext: string;
  tag: string;
  encrypted_key?: string | undefined;
}

export async function encryptJsonPayload(input: {
  payload: Record<string, unknown>;
  publicJwk: JWK;
  serviceKeyId: string;
  alg: string;
  enc: string;
}): Promise<WatasuFlattenedJwe> {
  assertAllowedJweParameters(input.alg, input.enc);

  const publicKey = await importJWK(input.publicJwk, input.alg);
  const encrypted = await new FlattenedEncrypt(
    new TextEncoder().encode(JSON.stringify(input.payload))
  )
    .setProtectedHeader({
      alg: input.alg,
      enc: input.enc,
      kid: input.serviceKeyId,
      typ: "watasu+jwe"
    })
    .encrypt(publicKey);

  return normalizeFlattenedJwe(encrypted);
}

export async function decryptJsonPayload(input: {
  encryptedPayload: WatasuFlattenedJwe;
  privateJwk: JWK;
  expectedServiceKeyId: string;
  alg: string;
  enc: string;
}): Promise<Record<string, unknown>> {
  assertAllowedJweParameters(input.alg, input.enc);

  const privateKey = await importJWK(input.privateJwk, input.alg);
  const decrypted = await flattenedDecrypt(input.encryptedPayload as FlattenedJWE, privateKey, {
    keyManagementAlgorithms: [input.alg],
    contentEncryptionAlgorithms: [input.enc]
  });

  if (decrypted.protectedHeader === undefined) {
    throw new Error("JWE protected header is required.");
  }

  if (decrypted.protectedHeader.kid !== input.expectedServiceKeyId) {
    throw new Error("JWE kid does not match the expected service key id.");
  }

  const parsedPayload = JSON.parse(new TextDecoder().decode(decrypted.plaintext));
  if (typeof parsedPayload !== "object" || parsedPayload === null || Array.isArray(parsedPayload)) {
    throw new Error("JWE plaintext payload must be a JSON object.");
  }

  return parsedPayload as Record<string, unknown>;
}

function assertAllowedJweParameters(alg: string, enc: string): asserts alg is WatasuJweAlgorithm {
  if (alg !== "ECDH-ES+A256KW") {
    throw new Error(`Unsupported JWE alg: ${alg}`);
  }

  if (enc !== "A256GCM") {
    throw new Error(`Unsupported JWE enc: ${enc}`);
  }
}

function normalizeFlattenedJwe(jwe: FlattenedJWE): WatasuFlattenedJwe {
  if (
    typeof jwe.protected !== "string" ||
    typeof jwe.iv !== "string" ||
    typeof jwe.ciphertext !== "string" ||
    typeof jwe.tag !== "string"
  ) {
    throw new Error("jose returned an incomplete flattened JWE object.");
  }

  return {
    protected: jwe.protected,
    iv: jwe.iv,
    ciphertext: jwe.ciphertext,
    tag: jwe.tag,
    encrypted_key: jwe.encrypted_key
  };
}
