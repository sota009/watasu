#!/usr/bin/env node

const targetOrigin = "https://api.watasu.ai";

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  target_origin: targetOrigin,
  before_render_commands: [
    "pnpm --silent cutover:prepare",
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
    "pnpm --silent cutover:ci",
    "pnpm --silent cutover:canary",
    "pnpm --silent cutover:retention"
  ],
  required_evidence: [
    "cutover-evidence/cutover-head.txt records the deployed commit SHA",
    "deploy:preflight ok=true",
    "smoke:hosted checked_status=200",
    "GitHub Actions CI green on the cutover head",
    `canary checked_origin=${targetOrigin}`,
    "canary checked_not_found_routes present",
    "canary checked_method_boundaries present",
    "canary checked_headers present",
    "canary checked_forbidden_fragments present",
    "canary checked_timeout_ms present",
    "retention checked_at present",
    "retention dry_run=true",
    "retention row counts present",
    "no payload body retained or printed"
  ],
  stop_conditions: [
    "Do not proceed if deploy:preflight reports a repo-side mismatch.",
    "Do not proceed if smoke:hosted cannot verify the low-information health response.",
    "Do not proceed if CI evidence does not match cutover-evidence/cutover-head.txt.",
    "Do not proceed if the canary output omits checked_forbidden_fragments or go_no_go.",
    "Do not proceed if retention dry run prints payload bodies, database URLs, or secret values."
  ]
})}\n`);
