#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|secret|token|password|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{24,}/i;

const ENV_FILE_PATTERN = /^\.env(?:\.|$)/;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);
const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

export function findSecretLikeValues(rootDir) {
  const findings = [];

  for (const filePath of listCandidateFiles(rootDir)) {
    const relPath = relative(rootDir, filePath);
    const fileName = relPath.split("/").at(-1) ?? relPath;

    if (ENV_FILE_PATTERN.test(fileName)) {
      findings.push({
        path: relPath,
        reason: "env files must not be committed"
      });
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    if (SECRET_ASSIGNMENT_PATTERN.test(content)) {
      findings.push({
        path: relPath,
        reason: "secret-like assignment detected"
      });
    }
  }

  return findings;
}

function listCandidateFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        files.push(...listCandidateFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function main() {
  if (!process.argv.includes("--repo")) {
    return;
  }

  const rootDir = process.cwd();
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    throw new Error(`Repository root does not exist: ${rootDir}`);
  }

  const findings = findSecretLikeValues(rootDir);
  if (findings.length > 0) {
    console.error(JSON.stringify({ ok: false, findings }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ ok: true, findings: [] }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
