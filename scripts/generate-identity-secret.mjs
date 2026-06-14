#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--plain")) {
  process.stderr.write("Usage: pnpm --silent secret:identity [--plain]\n");
  process.exit(1);
}

const byteLength = 32;
const value = randomBytes(byteLength).toString("base64url");

if (args[0] === "--plain") {
  process.stdout.write(`${value}\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify({
  env: "WATASU_SERVICE_IDENTITY_SIGNING_SECRET",
  format: "base64url",
  bytes: byteLength,
  value
})}\n`);
