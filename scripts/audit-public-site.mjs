#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const auditRoots = process.argv.slice(2).map((path) => resolve(path));
const roots = auditRoots.length > 0
  ? auditRoots
  : [
    resolve(repoRoot, "src/site"),
    resolve(repoRoot, "functions"),
    resolve(repoRoot, "dist/site"),
  ];

const requiredFiles = [
  "src/site/index.html",
  "src/site/main.tsx",
  "src/site/components/PlanbanPublicWebsite.tsx",
  "src/site/public/_redirects",
  "functions/api/subscribe.ts",
  "dist/site/index.html",
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
  "test-results",
]);

const forbiddenFileNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "AGENTS.md",
  "CLAUDE.md",
  "CLOUD.md",
  "cloud.md",
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
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
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

function displayPath(path) {
  const rel = relative(repoRoot, path);
  return rel.startsWith("..") ? path : rel;
}

async function walk(dir, results = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = displayPath(path);
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
    else results.push({ type: "file", path: rel, absolutePath: path });
  }
  return results;
}

const findings = [];

for (const file of requiredFiles) {
  if (!(await pathExists(resolve(repoRoot, file)))) {
    findings.push({ type: "missing-required-file", path: file });
  }
}

for (const root of roots) {
  if (!(await pathExists(root))) {
    findings.push({ type: "missing-audit-root", path: displayPath(root) });
    continue;
  }
  const entries = await walk(root);
  for (const entry of entries) {
    if (entry.type !== "file") {
      findings.push(entry);
      continue;
    }
    if (!textExtensions.has(extension(entry.path))) continue;
    const text = await readFile(entry.absolutePath, "utf8");
    for (const rule of forbiddenContent) {
      if (rule.pattern.test(text)) {
        findings.push({ type: "forbidden-content", path: entry.path, rule: rule.name });
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(JSON.stringify({ ok: false, roots: roots.map(displayPath), findings }, null, 2) + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ ok: true, roots: roots.map(displayPath), checkedRequiredFiles: requiredFiles.length }, null, 2) + "\n");
}
