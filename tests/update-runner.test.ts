import assert from "node:assert/strict";
import test from "node:test";
import { buildUpdateCommandPlan } from "../src/core/updateRunner";
import type { PlanbanUpdatePreflight } from "../src/core/updatePreflight";
import type { PlanbanUpdateManifest } from "../src/core/version";

function preflight(overrides: Partial<PlanbanUpdatePreflight>): PlanbanUpdatePreflight {
  return {
    checkedAt: "2026-06-12T00:00:00.000Z",
    runtimeRoot: "/tmp/planban",
    codexHome: "/tmp/codex-home",
    installShape: "git-marketplace",
    directUpdateAvailable: true,
    prerequisites: {
      node: { command: "node", available: true, version: "v24", error: null },
      npm: { command: "npm", available: true, version: "11", error: null },
      git: { command: "git", available: true, version: "git version 2", error: null },
      codex: { command: "codex", available: true, version: "codex 0", error: null },
    },
    marketplace: {
      name: "planban",
      root: "/tmp/planban",
      sourceType: "git",
      source: "https://github.com/piercekearns/planban.git",
    },
    git: {
      isRepo: true,
      root: "/tmp/planban",
      branch: "main",
      remote: "https://github.com/piercekearns/planban.git",
      head: "abc123",
      dirtyFiles: [],
      generatedSafeDirtyFiles: [],
      blockingDirtyFiles: [],
    },
    blockedReasons: [],
    warnings: [],
    recommendedAction: "update-now",
    setupPrompt: null,
    fallbackPrompt: "fallback",
    ...overrides,
  };
}

const manifest: PlanbanUpdateManifest = {
  schemaVersion: 1,
  version: "0.1.6",
  pluginVersion: "0.1.6",
  mcpVersion: "0.1.6",
  storageSchemaVersion: 1,
  minimumStorageSchemaVersion: 1,
  publishedAt: "2026-06-12T00:00:00.000Z",
  sourceUrl: "https://github.com/piercekearns/planban",
  releaseNotesUrl: "https://github.com/piercekearns/planban/releases/tag/v0.1.6",
  targetRef: "main",
  targetCommit: "def456",
  summary: "Update",
  updatePrompt: "Update Planban.",
};

test("builds Git-backed marketplace update command plan", () => {
  const plan = buildUpdateCommandPlan(preflight({}), manifest);
  assert.deepEqual(plan.map((step) => step.id), [
    "refresh-marketplace",
    "install-dependencies",
    "configure-plugin",
    "install-plugin",
    "verify-install",
  ]);
  assert.deepEqual(plan[0]?.args, ["plugin", "marketplace", "upgrade", "planban"]);
  assert.equal(plan[1]?.cwd, "/tmp/planban");
  assert.deepEqual(plan[3]?.env, { CODEX_HOME: "/tmp/codex-home" });
  assert.deepEqual(plan[4]?.args, [
    "--import",
    "tsx/esm",
    "scripts/verify-local-install.mjs",
    "--root",
    "/tmp/planban",
    "--expected-version",
    "0.1.6",
    "--codex-home",
    "/tmp/codex-home",
  ]);
});

test("builds local clone update command plan with target commit", () => {
  const plan = buildUpdateCommandPlan(preflight({
    installShape: "local-clone",
    marketplace: {
      name: "planban",
      root: "/tmp/planban",
      sourceType: "local",
      source: "/tmp/planban",
    },
  }), manifest);

  assert.deepEqual(plan.map((step) => step.id), [
    "fetch-update",
    "fast-forward",
    "install-dependencies",
    "configure-plugin",
    "install-plugin",
    "verify-install",
  ]);
  assert.deepEqual(plan[0]?.args, ["fetch", "origin", "main"]);
  assert.deepEqual(plan[1]?.args, ["merge", "--ff-only", "def456"]);
});

test("cleans generated install artifacts before updating dirty local clone", () => {
  const plan = buildUpdateCommandPlan(preflight({
    installShape: "local-clone",
    marketplace: {
      name: "planban",
      root: "/tmp/planban",
      sourceType: "local",
      source: "/tmp/planban",
    },
    git: {
      isRepo: true,
      root: "/tmp/planban",
      branch: "main",
      remote: "https://github.com/piercekearns/planban.git",
      head: "abc123",
      dirtyFiles: ["package-lock.json"],
      generatedSafeDirtyFiles: ["package-lock.json"],
      blockingDirtyFiles: [],
    },
  }), manifest);

  assert.deepEqual(plan.map((step) => step.id), [
    "prepare-install-artifacts",
    "fetch-update",
    "fast-forward",
    "install-dependencies",
    "configure-plugin",
    "install-plugin",
    "verify-install",
  ]);
  assert.deepEqual(plan[0]?.args, ["scripts/prepare-local-update.mjs", "/tmp/planban"]);
});

test("does not build a direct command plan for blocked installs", () => {
  const plan = buildUpdateCommandPlan(preflight({
    directUpdateAvailable: false,
    recommendedAction: "update-with-codex",
    blockedReasons: ["blocked"],
  }), manifest);

  assert.deepEqual(plan, []);
});
