import { canonicalizeJson, type RequestDefinition } from "./request-definition.js";
import { sha256Hash, type Sha256Hash } from "./hash.js";

export interface RequestVersionHashes {
  request_version_hash: Sha256Hash;
  schema_hash: Sha256Hash;
  consent_text_hash: Sha256Hash;
  field_purposes_hash: Sha256Hash;
  destination_policy_hash: Sha256Hash;
  public_key_fingerprint: Sha256Hash;
}

export interface PublishedRequestVersion {
  request_id: string;
  request_version: string;
  definition: RequestDefinition;
  hashes: RequestVersionHashes;
  published_at: string;
}

export class InMemoryRequestVersionRepository {
  readonly #versionsByRequestId = new Map<string, PublishedRequestVersion[]>();

  publish(requestId: string, definition: RequestDefinition): PublishedRequestVersion {
    const existingVersions = this.#versionsByRequestId.get(requestId) ?? [];
    const hashes = createRequestVersionHashes(definition);
    const existingVersion = existingVersions.find(
      (version) => version.hashes.request_version_hash === hashes.request_version_hash
    );

    if (existingVersion !== undefined) {
      return existingVersion;
    }

    const published = deepFreeze({
      request_id: requestId,
      request_version: `v${existingVersions.length + 1}`,
      definition: structuredClone(definition),
      hashes,
      published_at: new Date().toISOString()
    });

    this.#versionsByRequestId.set(requestId, [...existingVersions, published]);
    return published;
  }

  list(requestId: string): PublishedRequestVersion[] {
    return [...(this.#versionsByRequestId.get(requestId) ?? [])];
  }
}

export function createRequestVersionHashes(definition: RequestDefinition): RequestVersionHashes {
  return {
    request_version_hash: hashJson(definition),
    schema_hash: hashJson({
      fields: definition.fields.map((field) => ({
        id: field.id,
        type: field.type,
        required: field.required,
        format: field.format
      }))
    }),
    consent_text_hash: sha256Hash(definition.consent.text),
    field_purposes_hash: hashJson(
      definition.fields.map((field) => ({
        id: field.id,
        purpose: field.purpose
      }))
    ),
    destination_policy_hash: sha256Hash(definition.retention.destination_policy),
    public_key_fingerprint: hashJson(definition.encryption.public_key_jwk)
  };
}

function hashJson(value: unknown): Sha256Hash {
  return sha256Hash(canonicalizeJson(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach((nestedValue) => deepFreeze(nestedValue));
  }

  return value;
}
