#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const releaseRoot = resolve(process.argv[2] ?? "tmp/planban-public-release");

const requiredFiles = [
  "README.md",
  "LICENSE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/feedback.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  "package.json",
  "release/latest.json",
  ".agents/plugins/marketplace.json",
  "dist/web/index.html",
  "plugins/planban/.codex-plugin/plugin.json",
  "plugins/planban/.mcp.json",
  "plugins/planban/mcp/server.mjs",
  "plugins/planban/scripts/launch-planban.mjs",
  "scripts/configure-local-plugin.mjs",
  "src/core/storage.ts",
  "src/core/demo.ts",
];

const forbiddenSegments = new Set([
  ".git",
  ".planban",
  ".codex",
  ".claude",
  ".cursor",
  "node_modules",
  "tmp",
  "coverage",
]);

const forbiddenFileNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "AGENTS.md",
  "CLAUDE.md",
  "CLOUD.md",
  "cloud.md",
  "tmp-planban-board-mcp-verify.png",
]);

const forbiddenContent = [
  { name: "GitHub token", pattern: /gho_[A-Za-z0-9_]+/u },
  { name: "OpenAI-style secret key", pattern: /\bsk-(?:proj|live|test|admin|svcacct)-[A-Za-z0-9_-]{16,}/u },
  { name: "Planban launch token", pattern: /planban:[a-z0-9-]+:[0-9a-f-]{36}/iu },
  { name: "private user home path", pattern: /\/Users\/piercekearns/u },
  { name: "private Planban home path", pattern: /\/Users\/piercekearns\/\.planban/u },
  { name: "private Codex attachment path", pattern: /\/\.codex\/attachments/u },
  { name: "private local temp screenshot", pattern: /tmp-planban-board-mcp-verify/u },
  { name: "private feedback transcript", pattern: /\bWhatsApp\b|\bOliver Griffiths\b|\bZoo-Lane\b|\bclawchestra\b/iu },
];

const textExtensions = new Set([
  ".json",
  ".md",
  ".mjs",
  ".js",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".txt",
]);

function extension(path) {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, results = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(releaseRoot, path);
    const segments = rel.split(sep);
    if (segments.some((segment) => forbiddenSegments.has(segment))) {
      results.push({ type: "forbidden-path", path: rel });
      continue;
    }
    if (forbiddenFileNames.has(entry.name)) {
      results.push({ type: "forbidden-file", path: rel });
      continue;
    }
    if (entry.isDirectory()) await walk(path, results);
    else results.push({ type: "file", path: rel });
  }
  return results;
}

const findings = [];

for (const file of requiredFiles) {
  if (!(await pathExists(join(releaseRoot, file)))) {
    findings.push({ type: "missing-required-file", path: file });
  }
}

if (await pathExists(releaseRoot)) {
  const entries = await walk(releaseRoot);
  for (const entry of entries) {
    if (entry.type !== "file") {
      findings.push(entry);
      continue;
    }
    if (!textExtensions.has(extension(entry.path))) continue;
    const text = await readFile(join(releaseRoot, entry.path), "utf8");
    for (const rule of forbiddenContent) {
      if (rule.pattern.test(text)) {
        findings.push({ type: "forbidden-content", path: entry.path, rule: rule.name });
      }
    }
  }
} else {
  findings.push({ type: "missing-release-root", path: releaseRoot });
}

if (findings.length > 0) {
  process.stderr.write(JSON.stringify({ ok: false, releaseRoot, findings }, null, 2) + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ ok: true, releaseRoot, checkedRequiredFiles: requiredFiles.length }, null, 2) + "\n");
}
