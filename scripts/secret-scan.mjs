import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const envFilePattern = /^\.env(?:\.|$)/;
const secretAssignmentPattern =
  /\b(?:api[_-]?key|token|secret|private[_-]?key|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{24,}/i;

export function findSecretLikeValues(rootDir) {
  const absoluteRoot = resolve(rootDir);
  const findings = [];

  for (const filePath of listFiles(absoluteRoot)) {
    const relativePath = relative(absoluteRoot, filePath);
    const fileName = relativePath.split("/").at(-1) ?? relativePath;

    if (envFilePattern.test(fileName)) {
      findings.push({
        path: relativePath,
        reason: "env files must not be committed"
      });
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    if (secretAssignmentPattern.test(content)) {
      findings.push({
        path: relativePath,
        reason: "secret-like assignment detected"
      });
    }
  }

  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

function listFiles(rootDir) {
  const files = [];

  for (const entry of readdirSync(rootDir)) {
    if (ignoredDirectories.has(entry)) {
      continue;
    }

    const entryPath = resolve(rootDir, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      files.push(...listFiles(entryPath));
      continue;
    }

    if (stats.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function runRepoScan() {
  const rootDir = process.cwd();
  const findings = findSecretLikeValues(rootDir);
  if (findings.length === 0) {
    return;
  }

  for (const finding of findings) {
    console.error(`${finding.path}: ${finding.reason}`);
  }
  process.exitCode = 1;
}

if (process.argv.includes("--repo")) {
  const insideGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  if (insideGit.status !== 0) {
    console.error("secret scan must run inside a git work tree");
    process.exitCode = 1;
  } else {
    runRepoScan();
  }
}

