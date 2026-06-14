#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const releaseRoot = resolve(process.argv[2] ?? join(repoRoot, "tmp", "planban-public-release"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`\nPreflight failed while running: ${command} ${args.join(" ")}\n`);
    process.exit(result.status ?? 1);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function previousPatchTag(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/u.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch) || patch <= 0) return null;
  return `v${major}.${minor}.${patch - 1}`;
}

function tagVersion(tag) {
  return tag.replace(/^v/u, "");
}

function versionParts(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function readPreviousReleaseManifest(tag) {
  const result = spawnSync("git", ["show", `${tag}:release/latest.json`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["audit", "--audit-level=high"]);
run("npm", ["run", "build"]);
run("npm", ["run", "site:preflight"]);
run("npm", ["run", "release:build", "--", releaseRoot]);
run("npm", ["run", "release:audit", "--", releaseRoot]);

const packageJson = await readJson(join(releaseRoot, "package.json"));
const releaseManifest = await readJson(join(releaseRoot, "release", "latest.json"));
const pluginManifest = await readJson(join(releaseRoot, "plugins", "planban", ".codex-plugin", "plugin.json"));
const previousTag = previousPatchTag(releaseManifest.version);
let previousTagCheck = "real previous-tag update rehearsal skipped";
if (previousTag) {
  const previousReleaseManifest = readPreviousReleaseManifest(previousTag);
  const previousStorageSchema = previousReleaseManifest?.storageSchemaVersion;
  const directUpdateSupportedFrom = typeof releaseManifest.directUpdateSupportedFrom === "string"
    ? releaseManifest.directUpdateSupportedFrom
    : null;
  if (directUpdateSupportedFrom && compareVersions(tagVersion(previousTag), directUpdateSupportedFrom) < 0) {
    previousTagCheck = `direct previous-tag update intentionally blocked (${previousTag} < directUpdateSupportedFrom ${directUpdateSupportedFrom})`;
  } else if (
    typeof previousStorageSchema === "number" &&
    releaseManifest.minimumStorageSchemaVersion > previousStorageSchema
  ) {
    previousTagCheck = `direct previous-tag update intentionally blocked (${previousTag} storage ${previousStorageSchema} < required ${releaseManifest.minimumStorageSchemaVersion})`;
  } else {
    run("node", ["scripts/test-release-upgrade-from-tag.mjs", "--from", previousTag, "--expected", releaseManifest.version]);
    previousTagCheck = `real previous-tag update rehearsal (${previousTag} -> ${releaseManifest.version})`;
  }
}

const findings = [];
if (packageJson.version !== releaseManifest.version) {
  findings.push(`package.json version ${packageJson.version} does not match release/latest.json version ${releaseManifest.version}`);
}
if (pluginManifest.version !== releaseManifest.pluginVersion) {
  findings.push(`plugin manifest version ${pluginManifest.version} does not match release pluginVersion ${releaseManifest.pluginVersion}`);
}
if (releaseManifest.version !== releaseManifest.pluginVersion || releaseManifest.version !== releaseManifest.mcpVersion) {
  findings.push("release/latest.json version, pluginVersion, and mcpVersion should match for this release line");
}
if (!releaseManifest.releaseNotesUrl?.endsWith(`/v${releaseManifest.version}`)) {
  findings.push(`release notes URL does not end with /v${releaseManifest.version}`);
}

if (findings.length > 0) {
  process.stderr.write(JSON.stringify({ ok: false, releaseRoot, findings }, null, 2) + "\n");
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  ok: true,
  releaseRoot,
  version: releaseManifest.version,
  checked: [
    "typecheck",
    "tests",
    "high-severity dependency audit",
    "build",
    "public website build and audit",
    "public release bundle",
    "public release audit",
    previousTagCheck,
    "version consistency",
  ],
}, null, 2) + "\n");
