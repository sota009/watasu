export interface CredentialRecord {
  /** base64url credential id — primary key. */
  credentialId: string;
  /** COSE public key bytes (from SimpleWebAuthn registrationInfo). */
  publicKey: Uint8Array;
  signCount: number;
  /** BE flag — the credential is sync-eligible (multiDevice). */
  backupEligible: boolean;
  /** BS flag — the credential is currently backed up/synced. */
  backupState: boolean;
  /** watasu-minted opaque id for the discoverable credential. */
  userHandle: string;
  transports?: string[];
  /** authenticator model id (analytics only). */
  aaguid?: string;
  createdAt: string;
}

export interface CredentialStore {
  save(record: CredentialRecord): Promise<void>;
  findByCredentialId(id: string): Promise<CredentialRecord | undefined>;
  updateSignCount(id: string, signCount: number): Promise<void>;
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly #byCredentialId = new Map<string, CredentialRecord>();

  async save(record: CredentialRecord): Promise<void> {
    this.#byCredentialId.set(record.credentialId, { ...record });
  }

  async findByCredentialId(id: string): Promise<CredentialRecord | undefined> {
    const found = this.#byCredentialId.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async updateSignCount(id: string, signCount: number): Promise<void> {
    const found = this.#byCredentialId.get(id);
    if (found !== undefined) {
      this.#byCredentialId.set(id, { ...found, signCount });
    }
  }
}
