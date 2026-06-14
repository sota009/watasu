export interface SecretScanFinding {
  path: string;
  reason: string;
}

export function findSecretLikeValues(rootDir: string): SecretScanFinding[];
