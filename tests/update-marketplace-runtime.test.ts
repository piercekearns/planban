import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  dependencyFingerprint,
  updateMarketplaceRuntime,
} from "../scripts/update-marketplace-runtime.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const currentMarker = {
  platform: process.platform,
  architecture: process.arch,
  nodeMajor: process.versions.node.split(".")[0],
  nodeModulesAbi: process.versions.modules ?? null,
};

async function fixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "planban-marketplace-runtime-"));
  const root = join(tempRoot, "marketplace", "planban");
  const codexHome = join(tempRoot, "codex-home");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(codexHome, { recursive: true })]);
  await Promise.all([
    cp(join(repoRoot, "package.json"), join(root, "package.json")),
    cp(join(repoRoot, "package-lock.json"), join(root, "package-lock.json")),
  ]);
  const modules = join(root, "node_modules");
  await Promise.all([
    mkdir(join(modules, "tsx"), { recursive: true }),
    mkdir(join(modules, "express"), { recursive: true }),
    mkdir(join(modules, "iconv-lite", "encodings"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(modules, "tsx", "package.json"), JSON.stringify({ exports: { "./esm": "./esm.mjs" } })),
    writeFile(join(modules, "tsx", "esm.mjs"), "export {};\n"),
    writeFile(join(modules, "express", "package.json"), JSON.stringify({ main: "index.js" })),
    writeFile(join(modules, "express", "index.js"), "module.exports = {};\n"),
    writeFile(join(modules, "iconv-lite", "package.json"), JSON.stringify({ main: "index.js" })),
    writeFile(join(modules, "iconv-lite", "encodings", "index.js"), "module.exports = {};\n"),
  ]);
  return { tempRoot, root, codexHome };
}

function successfulCommandRecorder(onRefresh?: () => Promise<void>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runCommand = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "codex") await onRefresh?.();
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, runCommand };
}

test("dependency fingerprint ignores root release metadata", async () => {
  const current = JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8"));
  const changedRelease = structuredClone(current);
  changedRelease.name = "renamed-release";
  changedRelease.version = "99.0.0";
  changedRelease.packages[""].name = "renamed-release";
  changedRelease.packages[""].version = "99.0.0";
  assert.equal(
    dependencyFingerprint(JSON.stringify(current)),
    dependencyFingerprint(JSON.stringify(changedRelease)),
  );

  changedRelease.packages[""].dependencies.express = "999.0.0";
  assert.notEqual(
    dependencyFingerprint(JSON.stringify(current)),
    dependencyFingerprint(JSON.stringify(changedRelease)),
  );
});

test("reuses preserved dependencies only after verification", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const commands = successfulCommandRecorder();

  const result = await updateMarketplaceRuntime({
    root: context.root,
    codexHome: context.codexHome,
    runtimeMarker: currentMarker,
    runCommand: commands.runCommand,
  });

  assert.equal(result.dependencyMode, "reused");
  assert.deepEqual(commands.calls.map(({ command, args }) => [command, ...args]), [
    ["codex", "plugin", "marketplace", "upgrade", "planban"],
    ["npm", "ls", "--omit=dev", "--depth=0"],
  ]);
  assert.equal((await lstat(join(context.root, "node_modules"))).isDirectory(), true);
});

test("falls back to a clean install when dependencies change", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const commands = successfulCommandRecorder(async () => {
    const lockPath = join(context.root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages[""].dependencies.express = "999.0.0";
    await writeFile(lockPath, JSON.stringify(lock));
  });

  const result = await updateMarketplaceRuntime({
    root: context.root,
    codexHome: context.codexHome,
    runtimeMarker: currentMarker,
    runCommand: commands.runCommand,
  });

  assert.equal(result.dependencyMode, "clean-install");
  assert.equal(result.dependencyReason, "dependency-fingerprint-or-runtime-changed");
  assert.deepEqual(commands.calls.map(({ command }) => command), ["codex", "npm"]);
});

test("falls back when required runtime modules are missing", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  await rm(join(context.root, "node_modules", "express"), { recursive: true, force: true });
  const commands = successfulCommandRecorder();

  const result = await updateMarketplaceRuntime({
    root: context.root,
    codexHome: context.codexHome,
    runtimeMarker: currentMarker,
    runCommand: commands.runCommand,
  });

  assert.equal(result.dependencyMode, "clean-install");
  assert.equal(result.dependencyReason, "runtime-modules-missing");
  assert.deepEqual(commands.calls.map(({ command }) => command), ["codex", "npm"]);
});

test("falls back to a clean install when reuse verification fails", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const calls: string[] = [];
  const runCommand = async (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "npm" && args[0] === "ls") {
      return { exitCode: 1, stdout: "", stderr: "invalid tree" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await updateMarketplaceRuntime({
    root: context.root,
    codexHome: context.codexHome,
    runtimeMarker: currentMarker,
    runCommand,
  });

  assert.equal(result.dependencyMode, "clean-install");
  assert.equal(result.dependencyReason, "reuse-verification-failed");
  assert.deepEqual(calls, [
    "codex plugin marketplace upgrade planban",
    "npm ls --omit=dev --depth=0",
    "npm install",
  ]);
});

test("restores preserved dependencies when marketplace refresh fails", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const runCommand = async () => ({ exitCode: 1, stdout: "", stderr: "offline" });

  await assert.rejects(
    updateMarketplaceRuntime({
      root: context.root,
      codexHome: context.codexHome,
      runtimeMarker: currentMarker,
      runCommand,
    }),
    /offline/u,
  );
  assert.equal((await lstat(join(context.root, "node_modules"))).isDirectory(), true);
});

test("restores preserved dependencies when marketplace refresh cannot run", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const runCommand = async () => { throw new Error("spawn failed"); };

  await assert.rejects(
    updateMarketplaceRuntime({
      root: context.root,
      codexHome: context.codexHome,
      runtimeMarker: currentMarker,
      runCommand,
    }),
    /spawn failed/u,
  );
  assert.equal((await lstat(join(context.root, "node_modules"))).isDirectory(), true);
});

test("discards interrupted preservation from an incompatible runtime", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const cacheRoot = join(context.codexHome, ".planban-update-cache", "planban-marketplace-dependencies");
  await mkdir(cacheRoot, { recursive: true });
  await rename(join(context.root, "node_modules"), join(cacheRoot, "node_modules"));
  const lockfileText = await readFile(join(context.root, "package-lock.json"), "utf8");
  await writeFile(join(cacheRoot, "metadata.json"), JSON.stringify({
    schemaVersion: 1,
    root: context.root,
    fingerprint: dependencyFingerprint(lockfileText),
    runtime: { ...currentMarker, nodeMajor: "0" },
  }));
  const commands = successfulCommandRecorder();

  const result = await updateMarketplaceRuntime({
    root: context.root,
    codexHome: context.codexHome,
    runtimeMarker: currentMarker,
    runCommand: commands.runCommand,
  });

  assert.equal(result.recovery, "discarded-stale-cache");
  assert.equal(result.dependencyMode, "clean-install");
  assert.equal(result.dependencyReason, "node-modules-missing");
});

test("reports fallback installation failure instead of claiming success", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const runCommand = async (command: string) => command === "npm"
    ? { exitCode: 1, stdout: "", stderr: "registry unavailable" }
    : { exitCode: 0, stdout: "", stderr: "" };

  await assert.rejects(
    updateMarketplaceRuntime({
      root: context.root,
      codexHome: context.codexHome,
      runtimeMarker: currentMarker,
      disableReuse: true,
      runCommand,
    }),
    /registry unavailable/u,
  );
});

test("disable switch retains the existing clean-install path", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.tempRoot, { recursive: true, force: true }));
  const commands = successfulCommandRecorder();

  const result = await updateMarketplaceRuntime({
    root: context.root,
    codexHome: context.codexHome,
    runtimeMarker: currentMarker,
    disableReuse: true,
    runCommand: commands.runCommand,
  });

  assert.equal(result.dependencyMode, "clean-install");
  assert.equal(result.dependencyReason, "reuse-disabled");
  assert.deepEqual(commands.calls.map(({ command }) => command), ["codex", "npm"]);
});
