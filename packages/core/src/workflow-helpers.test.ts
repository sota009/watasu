import { describe, expect, test } from "vitest";
import {
  buildDraftPullRequestBody,
  buildLoopCommandPlan,
  buildPullRequestUrl,
  findFirstExistingPath,
  gstackReviewChecklistCandidates,
  parseGitHubRepositoryFullName,
  shouldRequireGstackReviewChecklist
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

  test("test_should_require_gstack_review_checklist_outside_ci", () => {
    expect(shouldRequireGstackReviewChecklist({})).toBe(true);
    expect(shouldRequireGstackReviewChecklist({ CI: "false" })).toBe(true);
  });

  test("test_should_not_require_gstack_review_checklist_in_ci", () => {
    expect(shouldRequireGstackReviewChecklist({ CI: "true" })).toBe(false);
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

  test("test_loop_command_plan_keeps_fast_loop_local_and_deterministic", () => {
    const plan = buildLoopCommandPlan({ includeAudit: false });

    expect(plan.map((command) => command.label)).toEqual([
      "typecheck",
      "test",
      "lint",
      "gstack-review-preflight"
    ]);
    expect(plan.some((command) => command.command.includes("audit"))).toBe(false);
  });

  test("test_loop_command_plan_avoids_duplicate_typecheck_during_tests", () => {
    const plan = buildLoopCommandPlan({ includeAudit: false });

    expect(plan.find((command) => command.label === "test")).toEqual({
      label: "test",
      command: "pnpm exec vitest run"
    });
  });

  test("test_loop_command_plan_can_include_supply_chain_audit_for_full_gate", () => {
    const plan = buildLoopCommandPlan({ includeAudit: true });

    expect(plan.at(-1)).toEqual({
      label: "audit",
      command: "pnpm audit --audit-level moderate"
    });
  });
});
