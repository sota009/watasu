import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildDraftPullRequestBody,
  buildPullRequestUrl,
  parseGitHubRepositoryFullName
} from "./workflow-helpers.mjs";

const branchName = runGit(["branch", "--show-current"]) ?? "";
const remoteUrl = runGit(["remote", "get-url", "origin"]) ?? "";
const repositoryFullName = parseGitHubRepositoryFullName(remoteUrl);
const pullRequestUrl = buildPullRequestUrl({ remoteUrl, branchName });

if (branchName.length === 0 || repositoryFullName === null || pullRequestUrl === null) {
  console.error("Could not infer the GitHub repository or branch.");
  console.error("Expected an origin remote like git@github.com:owner/repo.git.");
  process.exit(1);
}

const authStatus = spawnSync("gh", ["auth", "status"], {
  cwd: process.cwd(),
  encoding: "utf8"
});
if (authStatus.status !== 0) {
  console.log("gh is not authenticated, so the branch can be pushed but PR creation needs login.");
  console.log("Run: gh auth login -h github.com");
  console.log(`Then open: ${pullRequestUrl}`);
  process.exit(0);
}

const body = buildDraftPullRequestBody({
  validationLines: [
    "pnpm typecheck",
    "pnpm test",
    "pnpm lint",
    "pnpm audit --audit-level moderate"
  ],
  selfReview: "Run `pnpm review:self` before opening or updating this PR."
});
const bodyPath = join(mkdtempSync(join(tmpdir(), "watasu-pr-")), "body.md");
writeFileSync(bodyPath, body);

const title = `[codex] ${branchName.replace(/^codex[-/]/, "").replaceAll("-", " ")}`;
const createResult = spawnSync(
  "gh",
  [
    "pr",
    "create",
    "--draft",
    "--base",
    "main",
    "--head",
    branchName,
    "--title",
    title,
    "--body-file",
    bodyPath
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit"
  }
);

if (createResult.status !== 0) {
  console.log(`Fallback URL: ${pullRequestUrl}`);
}

process.exit(createResult.status ?? 1);

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

