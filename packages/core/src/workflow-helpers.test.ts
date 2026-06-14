import { describe, expect, test } from "vitest";
import {
  buildDraftPullRequestBody,
  buildPullRequestUrl,
  findFirstExistingPath,
  gstackReviewChecklistCandidates,
  parseGitHubRepositoryFullName
} from "../../../scripts/workflow-helpers.mjs";

describe("workflow helpers", () => {
  test("test_gstack_review_checklist_candidates_include_repo_and_global_paths", () => {
    const candidates = gstackReviewChecklistCandidates({
      repoRoot: "/repo",
      homeDir: "/home/user"
    });

    expect(candidates).toEqual([
      "/repo/.agents/skills/gstack/review/checklist.md",
      "/home/user/.codex/skills/gstack/review/checklist.md",
      "/home/user/.codex/gstack-source/review/checklist.md"
    ]);
  });

  test("test_find_first_existing_path_returns_first_available_candidate", () => {
    const result = findFirstExistingPath(["/missing", "/found", "/later"], (path) => path === "/found");

    expect(result).toBe("/found");
  });

  test("test_parse_github_repository_full_name_supports_ssh_and_https_remotes", () => {
    expect(parseGitHubRepositoryFullName("git@github.com:sota009/watasu.git")).toBe(
      "sota009/watasu"
    );
    expect(parseGitHubRepositoryFullName("https://github.com/sota009/watasu.git")).toBe(
      "sota009/watasu"
    );
  });

  test("test_build_pull_request_url_uses_current_branch", () => {
    const url = buildPullRequestUrl({
      remoteUrl: "git@github.com:sota009/watasu.git",
      branchName: "codex-repository-foundation"
    });

    expect(url).toBe("https://github.com/sota009/watasu/pull/new/codex-repository-foundation");
  });

  test("test_build_draft_pull_request_body_contains_validation_and_review_notes", () => {
    const body = buildDraftPullRequestBody({
      validationLines: ["pnpm test"],
      selfReview: "Self-review clean."
    });

    expect(body).toContain("- `pnpm test`");
    expect(body).toContain("Self-review clean.");
  });
});

