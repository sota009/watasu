#!/usr/bin/env node

const targetOrigin = "https://api.watasu.ai";

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  target_origin: targetOrigin,
  before_render_commands: [
    "pnpm --silent deploy:preflight",
    "pnpm --silent smoke:hosted",
    "pnpm --silent secret:identity --plain"
  ],
  external_actions: [
    "Enable the Render workspace billing for the web service and paid PostgreSQL.",
    "Connect the GitHub repository to Render with least necessary repository access.",
    "Create the Render Blueprint services and managed PostgreSQL database.",
    "Enter the generated WATASU_SERVICE_IDENTITY_SIGNING_SECRET value only in the Render web service secret prompt.",
    "Verify api.watasu.ai DNS and TLS in Render.",
    "Share the deployed production URL back for canary evidence collection."
  ],
  after_deploy_commands: [
    "gh run list --workflow ci --branch main --limit 1 --json workflowName,status,conclusion,headSha,url,createdAt > ci.json",
    `pnpm canary:hosted -- ${targetOrigin}`,
    "pnpm --filter @watasu/hosted retention -- --dry-run"
  ],
  required_evidence: [
    "deploy:preflight ok=true",
    "smoke:hosted checked_status=200",
    "GitHub Actions CI green on deployed commit",
    `canary checked_origin=${targetOrigin}`,
    "canary checked_forbidden_fragments present",
    "retention dry_run=true",
    "no payload body retained or printed"
  ],
  stop_conditions: [
    "Do not proceed if deploy:preflight reports a repo-side mismatch.",
    "Do not proceed if smoke:hosted cannot verify the low-information health response.",
    "Do not proceed if the canary output omits checked_forbidden_fragments or go_no_go.",
    "Do not proceed if retention dry run prints payload bodies, database URLs, or secret values."
  ]
})}\n`);
