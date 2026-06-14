import { existsSync } from "node:fs";

export function gstackReviewChecklistCandidates({ repoRoot, homeDir }) {
  return [
    `${repoRoot}/.agents/skills/gstack/review/checklist.md`,
    `${homeDir}/.codex/skills/gstack/review/checklist.md`,
    `${homeDir}/.codex/gstack-source/review/checklist.md`
  ];
}

export function findFirstExistingPath(paths, pathExists = existsSync) {
  return paths.find((path) => pathExists(path)) ?? null;
}

export function shouldRequireGstackReviewChecklist(env) {
  return env["CI"] !== "true";
}

export function parseGitHubRepositoryFullName(remoteUrl) {
  const normalizedUrl = remoteUrl.trim();
  const sshMatch = normalizedUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1] !== undefined) {
    return sshMatch[1];
  }

  const httpsMatch = normalizedUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch?.[1] !== undefined) {
    return httpsMatch[1];
  }

  return null;
}

export function buildPullRequestUrl({ remoteUrl, branchName }) {
  const repositoryFullName = parseGitHubRepositoryFullName(remoteUrl);
  if (repositoryFullName === null) {
    return null;
  }

  return `https://github.com/${repositoryFullName}/pull/new/${encodeURIComponent(branchName)}`;
}

export function buildDraftPullRequestBody({ validationLines, selfReview }) {
  return `## What changed

- Prepared the repository changes on this branch.
- Kept validation and review notes attached to the PR for reviewer handoff.

## Validation

${validationLines.map((line) => `- \`${line}\``).join("\n")}

## Self-review

${selfReview}`;
}

export function buildLoopCommandPlan({ includeAudit = false } = {}) {
  const commands = [
    {
      label: "typecheck",
      command: "pnpm typecheck"
    },
    {
      label: "test",
      command: "pnpm test"
    },
    {
      label: "lint",
      command: "pnpm lint"
    },
    {
      label: "gstack-review-preflight",
      command: "pnpm review:self"
    }
  ];

  if (includeAudit) {
    commands.push({
      label: "audit",
      command: "pnpm audit --audit-level moderate"
    });
  }

  return commands;
}
