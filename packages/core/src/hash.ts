import { createHash } from "node:crypto";

export type Sha256Hash = `sha256:${string}`;

export function sha256Hash(input: string | Uint8Array): Sha256Hash {
  const digest = createHash("sha256").update(input).digest("base64url");
  return `sha256:${digest}`;
}
