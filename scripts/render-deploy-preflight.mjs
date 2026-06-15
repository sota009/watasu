#!/usr/bin/env node
import { readFileSync } from "node:fs";

const requiredChecks = [
  {
    file: "render.yaml",
    description: "Render web service is configured for api.watasu.ai",
    pattern: /name:\s+watasu-hosted[\s\S]*?type:\s+cron|type:\s+web[\s\S]*?name:\s+watasu-hosted[\s\S]*?-\s+api\.watasu\.ai/
  },
  {
    file: "render.yaml",
    description: "Render web service waits for CI checks",
    pattern: /autoDeployTrigger:\s+checksPass/
  },
  {
    file: "render.yaml",
    description: "Render web service starts through the hosted package start script",
    pattern: /startCommand:\s+pnpm --filter @watasu\/hosted start/
  },
  {
    file: "render.yaml",
    description: "Render retention cron starts through the hosted package retention script",
    pattern: /startCommand:\s+pnpm --filter @watasu\/hosted retention/
  },
  {
    file: "render.yaml",
    description: "Render web service keeps the identity signing secret out of git",
    pattern: /key:\s+WATASU_SERVICE_IDENTITY_SIGNING_SECRET\s*\n\s*sync:\s+false/
  },
  {
    file: "render.yaml",
    description: "Render web service keeps the MCP bearer token out of git",
    pattern: /key:\s+WATASU_MCP_BEARER_TOKEN\s*\n\s*sync:\s+false/
  },
  {
    file: "render.yaml",
    description: "Render web service keeps database credentials out of the web runtime",
    forbiddenPattern: /name:\s+watasu-hosted[\s\S]*?key:\s+WATASU_POSTGRES_URL[\s\S]*?type:\s+cron/
  },
  {
    file: "render.yaml",
    description: "Render retention cron receives the managed Postgres connection string",
    pattern: /name:\s+watasu-metadata-retention[\s\S]*?key:\s+WATASU_POSTGRES_URL[\s\S]*?fromDatabase:[\s\S]*?name:\s+watasu-metadata[\s\S]*?property:\s+connectionString/
  },
  {
    file: "docs/mvp-plan.md",
    description: "Private-alpha plan records the acquired domain",
    pattern: /\[x\] Domain acquired and dedicated API subdomain chosen: `api\.watasu\.ai`/
  },
  {
    file: "README.md",
    description: "Operator docs use plain secret output for Render",
    pattern: /pnpm --silent secret:identity --plain/
  },
  {
    file: "packages/hosted/package.json",
    description: "Hosted package start script runs the compiled web entrypoint",
    pattern: /"start":\s*"node dist\/bin\.js"/
  },
  {
    file: "packages/hosted/package.json",
    description: "Hosted package retention script runs the compiled retention entrypoint",
    pattern: /"retention":\s*"node dist\/retention-bin\.js"/
  },
  {
    file: "packages/hosted/src/bin.ts",
    description: "Hosted web source entrypoint exists for the compiled start command",
    pattern: /createHostedProductionServerFromEnv/
  },
  {
    file: "packages/hosted/src/retention-bin.ts",
    description: "Hosted retention source entrypoint exists for the compiled cron command",
    pattern: /runHostedPostgresRetentionJobFromEnv/
  }
];

function readWorkspaceFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const failures = [];

for (const check of requiredChecks) {
  const content = readWorkspaceFile(check.file);
  if (check.pattern !== undefined && !check.pattern.test(content)) {
    failures.push(`${check.file}: ${check.description}`);
  }
  if (check.forbiddenPattern !== undefined && check.forbiddenPattern.test(content)) {
    failures.push(`${check.file}: ${check.description}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Render deploy preflight failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  checked_domain: "api.watasu.ai",
  checked_render_services: ["watasu-hosted", "watasu-metadata-retention", "watasu-metadata"],
  checked_runtime_commands: [
    "pnpm --filter @watasu/hosted start",
    "pnpm --filter @watasu/hosted retention"
  ],
  checked_secret_command: "pnpm --silent secret:identity --plain",
  remaining_external_actions: [
    "Render workspace and billing enabled",
    "GitHub repository connected to Render",
    "Render secret value entered",
    "api.watasu.ai DNS and TLS verified",
    "post-deploy hosted canary passed"
  ]
})}\n`);
