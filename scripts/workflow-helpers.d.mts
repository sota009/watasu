export function gstackReviewChecklistCandidates(input: {
  repoRoot: string;
  homeDir: string;
}): string[];

export function findFirstExistingPath(
  paths: string[],
  pathExists?: (path: string) => boolean
): string | null;

export function shouldRequireGstackReviewChecklist(env: Record<string, string | undefined>): boolean;

export function parseGitHubRepositoryFullName(remoteUrl: string): string | null;

export function buildPullRequestUrl(input: {
  remoteUrl: string;
  branchName: string;
}): string | null;

export function buildDraftPullRequestBody(input: {
  validationLines: string[];
  selfReview: string;
}): string;

export type LoopCommand = {
  label: string;
  command: string;
};

export function buildLoopCommandPlan(input?: { includeAudit?: boolean }): LoopCommand[];
