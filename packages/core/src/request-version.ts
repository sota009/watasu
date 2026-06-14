import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeJson, type RequestDefinition } from "./request-definition.js";
import { sha256Hash, type Sha256Hash } from "./hash.js";
import { generatePlaintextPayloadSchema } from "./schema.js";

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

export class FileSystemRequestVersionRepository {
  constructor(readonly storeRoot: string) {}

  async publish(requestId: string, definition: RequestDefinition): Promise<PublishedRequestVersion> {
    assertSafeRequestId(requestId);

    const existingVersions = await this.list(requestId);
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
    const requestDirectory = this.requestDirectory(requestId);

    await mkdir(requestDirectory, { recursive: true });
    await writeFile(
      join(requestDirectory, `${published.request_version}.json`),
      `${canonicalizeJson(published)}\n`,
      "utf8"
    );
    await this.writeIndex(requestId, [...existingVersions, published]);

    return published;
  }

  async list(requestId: string): Promise<PublishedRequestVersion[]> {
    assertSafeRequestId(requestId);

    const index = await this.readIndex(requestId);
    if (index === undefined) {
      return [];
    }

    const versions = await Promise.all(
      index.versions.map(async (version) => {
        const versionJson = await readFile(
          join(this.requestDirectory(requestId), `${version.request_version}.json`),
          "utf8"
        );
        return deepFreeze(JSON.parse(versionJson) as PublishedRequestVersion);
      })
    );

    return versions;
  }

  private async readIndex(requestId: string): Promise<RequestVersionIndex | undefined> {
    try {
      const indexJson = await readFile(join(this.requestDirectory(requestId), "index.json"), "utf8");
      return JSON.parse(indexJson) as RequestVersionIndex;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  private requestDirectory(requestId: string): string {
    return join(this.storeRoot, "requests", requestId);
  }

  private async writeIndex(
    requestId: string,
    versions: PublishedRequestVersion[]
  ): Promise<void> {
    const index: RequestVersionIndex = {
      request_id: requestId,
      versions: versions.map((version) => ({
        request_version: version.request_version,
        request_version_hash: version.hashes.request_version_hash,
        published_at: version.published_at
      }))
    };

    await writeFile(
      join(this.requestDirectory(requestId), "index.json"),
      `${canonicalizeJson(index)}\n`,
      "utf8"
    );
  }
}

export function createRequestVersionHashes(definition: RequestDefinition): RequestVersionHashes {
  return {
    request_version_hash: hashJson(definition),
    schema_hash: hashJson(generatePlaintextPayloadSchema(definition)),
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

interface RequestVersionIndex {
  request_id: string;
  versions: Array<{
    request_version: string;
    request_version_hash: Sha256Hash;
    published_at: string;
  }>;
}

function hashJson(value: unknown): Sha256Hash {
  return sha256Hash(canonicalizeJson(value));
}

function assertSafeRequestId(requestId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(requestId)) {
    throw new Error("request_id must use only letters, numbers, dots, underscores, and hyphens");
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach((nestedValue) => deepFreeze(nestedValue));
  }

  return value;
}
