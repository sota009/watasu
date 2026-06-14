import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  findFirstExistingPath,
  gstackReviewChecklistCandidates
} from "./workflow-helpers.mjs";

const repoRoot = runGit(["rev-parse", "--show-toplevel"]) ?? process.cwd();
const currentBranch = runGit(["branch", "--show-current"]) ?? "unknown";
const baseBranch = detectBaseBranch() ?? "main";
const checklistPath = findFirstExistingPath(
  gstackReviewChecklistCandidates({ repoRoot, homeDir: homedir() })
);

if (checklistPath === null) {
  console.error("gstack review checklist was not found.");
  console.error("Checked:");
  for (const candidate of gstackReviewChecklistCandidates({ repoRoot, homeDir: homedir() })) {
    console.error(`- ${candidate}`);
  }
  process.exit(1);
}

console.log(`Checklist: ${checklistPath}`);
console.log(`Branch: ${currentBranch}`);
console.log(`Base: ${baseBranch}`);
console.log("");
console.log("Validation:");
console.log("- pnpm typecheck");
console.log("- pnpm test");
console.log("- pnpm lint");
console.log("- pnpm audit --audit-level moderate");
console.log("");
console.log("Review diff:");
console.log(`git fetch origin ${baseBranch} --quiet`);
console.log(`git diff "$(git merge-base origin/${baseBranch} HEAD)"`);

function detectBaseBranch() {
  const remoteHead = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (remoteHead?.startsWith("refs/remotes/origin/") === true) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }

  if (runGit(["rev-parse", "--verify", "origin/main"]) !== null) {
    return "main";
  }

  if (runGit(["rev-parse", "--verify", "origin/master"]) !== null) {
    return "master";
  }

  return null;
}

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

