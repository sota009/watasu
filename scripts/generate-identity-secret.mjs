#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const byteLength = 32;
const value = randomBytes(byteLength).toString("base64url");

process.stdout.write(`${JSON.stringify({
  env: "WATASU_SERVICE_IDENTITY_SIGNING_SECRET",
  format: "base64url",
  bytes: byteLength,
  value
})}\n`);
