#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write("Usage: pnpm --silent invite:publish --owner <owner-id> --tenant <tenant-id> [--max-publish-count 1] [--ttl-days 30]\n");
  process.exit(0);
}

try {
  const ownerId = requireValue(args.owner, "owner");
  const tenantId = requireValue(args.tenant, "tenant");
  const maxPublishCount = parsePositiveInteger(args.maxPublishCount ?? "1", "max-publish-count");
  const ttlDays = parsePositiveInteger(args.ttlDays ?? "30", "ttl-days");
  const token = `wpi_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const record = {
    token,
    owner_id: ownerId,
    tenant_id: tenantId,
    roles: ["publisher"],
    expires_at: expiresAt,
    max_publish_count: maxPublishCount
  };

  process.stdout.write(`${JSON.stringify({
    share_token_once: token,
    env_record: record,
    env_var: "WATASU_HOSTED_PUBLISH_INVITES_JSON"
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid hosted publish invite arguments."}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    const value = argv[index + 1];
    if (arg === "--owner") {
      parsed.owner = value;
      index += 1;
      continue;
    }
    if (arg === "--tenant") {
      parsed.tenant = value;
      index += 1;
      continue;
    }
    if (arg === "--max-publish-count") {
      parsed.maxPublishCount = value;
      index += 1;
      continue;
    }
    if (arg === "--ttl-days") {
      parsed.ttlDays = value;
      index += 1;
      continue;
    }

    throw new Error("Usage: pnpm --silent invite:publish --owner <owner-id> --tenant <tenant-id> [--max-publish-count 1] [--ttl-days 30]");
  }

  return parsed;
}

function requireValue(value, name) {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required --${name}.`);
  }

  return value.trim();
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }

  return parsed;
}
