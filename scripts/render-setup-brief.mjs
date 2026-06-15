#!/usr/bin/env node
import { readFileSync } from "node:fs";

const renderYaml = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");

const webService = captureRequired(renderYaml, /type:\s+web[\s\S]*?name:\s+([^\n]+)/, "web service");
const retentionService = captureRequired(renderYaml, /type:\s+cron[\s\S]*?name:\s+([^\n]+)/, "retention service");
const database = captureRequired(renderYaml, /databases:[\s\S]*?-\s+name:\s+([^\n]+)/, "database");
const domain = captureRequired(renderYaml, /domains:\s*\n\s*-\s+([^\n]+)/, "domain");
const region = captureRequired(renderYaml, /region:\s+([^\n]+)/, "region");
const webPlan = captureRequired(renderYaml, /type:\s+web[\s\S]*?plan:\s+([^\n]+)/, "web plan");
const databasePlan = captureRequired(renderYaml, /databases:[\s\S]*?plan:\s+([^\n]+)/, "database plan");

process.stdout.write(`${JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  target_domain: domain,
  dns_origin: `https://${domain}`,
  render_region: region,
  render_services: [webService, retentionService],
  render_database: database,
  render_plans: {
    web: webPlan,
    database: databasePlan
  },
  blueprint_file: "render.yaml",
  secret_command: "pnpm --silent secret:identity --plain",
  status_command: "pnpm --silent cutover:status",
  manual_secret_names: ["WATASU_SERVICE_IDENTITY_SIGNING_SECRET", "WATASU_MCP_BEARER_TOKEN"],
  render_managed_secret_names: ["WATASU_POSTGRES_URL"],
  external_actions: [
    "Enable Render workspace billing for the web service and paid PostgreSQL.",
    "Connect the GitHub repository to Render with least necessary repository access.",
    "Run pnpm --silent cutover:status before and after Render setup.",
    "Create the Render Blueprint from render.yaml.",
    "Enter WATASU_SERVICE_IDENTITY_SIGNING_SECRET only in the Render web service secret prompt.",
    "Enter WATASU_MCP_BEARER_TOKEN only in the Render web service secret prompt; use a distinct 32+ byte random value.",
    "Add api.watasu.ai as the Render custom domain, configure the DNS record Render gives you, then verify DNS/TLS in Render."
  ],
  before_render_commands: [
    "pnpm --silent cutover:repo",
    "pnpm --silent cutover:status",
    "pnpm --silent secret:identity --plain"
  ],
  after_render_commands: [
    "pnpm --silent cutover:status",
    "pnpm --silent cutover:canary",
    "pnpm --silent cutover:retention",
    "pnpm --silent cutover:verify"
  ]
})}\n`);

function captureRequired(input, pattern, label) {
  const match = input.match(pattern);
  if (match?.[1] === undefined) {
    throw new Error(`render.yaml is missing ${label}.`);
  }
  return match[1].trim().replace(/^"|"$/g, "");
}
