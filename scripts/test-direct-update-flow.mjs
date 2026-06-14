#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(stderr || `${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function patchVersion(root, version, latestVersion = version) {
  const packagePath = join(root, "package.json");
  const packageJson = await readJson(packagePath);
  packageJson.version = version;
  await writeJson(packagePath, packageJson);

  const packageLockPath = join(root, "package-lock.json");
  const packageLock = await readJson(packageLockPath);
  packageLock.version = version;
  if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
  await writeJson(packageLockPath, packageLock);

  const releasePath = join(root, "release/latest.json");
  const release = await readJson(releasePath);
  release.version = latestVersion;
  release.pluginVersion = latestVersion;
  release.mcpVersion = latestVersion;
  release.releaseNotesUrl = `https://github.com/piercekearns/planban/releases/tag/v${latestVersion}`;
  release.targetRef = "main";
  delete release.targetCommit;
  release.summary = "Direct update harness release.";
  release.updatePrompt = "Update Planban through the direct update harness.";
  release.postUpdateRoute = "board-with-changelog";
  release.changelogTitle = "Direct update harness";
  release.changelogSummary = "The local direct updater moved this install to the next release.";
  await writeJson(releasePath, release);

  const pluginPath = join(root, "plugins/planban/.codex-plugin/plugin.json");
  const plugin = await readJson(pluginPath);
  plugin.version = version;
  await writeJson(pluginPath, plugin);

  const versionPath = join(root, "src/core/version.ts");
  let versionSource = await readFile(versionPath, "utf8");
  versionSource = versionSource
    .replace(/PLANBAN_VERSION = "[^"]+"/u, `PLANBAN_VERSION = "${version}"`)
    .replace(/PLANBAN_PLUGIN_VERSION = "[^"]+"/u, `PLANBAN_PLUGIN_VERSION = "${version}"`)
    .replace(/PLANBAN_MCP_VERSION = "[^"]+"/u, `PLANBAN_MCP_VERSION = "${version}"`);
  await writeFile(versionPath, versionSource, "utf8");
}

async function versionFrom(root) {
  const result = await run("node", [
    "--import",
    "tsx/esm",
    "-e",
    "const v = await import('./src/core/version.ts'); console.log(JSON.stringify(v.currentVersionInfo()));",
  ], { cwd: root, quiet: true });
  return JSON.parse(result.stdout);
}

async function main() {
  const keep = process.argv.includes("--keep");
  const tempRoot = await mkdtemp(join(tmpdir(), "planban-direct-update-"));
  const releaseRoot = join(tempRoot, "release-source");
  const originWork = join(tempRoot, "origin-work");
  const installRoot = join(tempRoot, "install-root");
  const codexHome = join(tempRoot, "codex-home");
  const planbanHome = join(tempRoot, "planban-home");

  try {
    await run("node", ["scripts/build-public-release.mjs", releaseRoot], { quiet: true });
    await cp(releaseRoot, originWork, { recursive: true });

    await patchVersion(originWork, "0.1.6", "0.1.7");
    await run("git", ["init", "-b", "main"], { cwd: originWork, quiet: true });
    await run("git", ["add", "."], { cwd: originWork, quiet: true });
    await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", "fixture 0.1.6"], {
      cwd: originWork,
      quiet: true,
    });

    await run("git", ["clone", originWork, installRoot], { quiet: true });

    await patchVersion(originWork, "0.1.7", "0.1.7");
    await writeFile(join(originWork, "DIRECT_UPDATE_HARNESS_MARKER.txt"), "updated\n", "utf8");
    await run("git", ["add", "."], { cwd: originWork, quiet: true });
    await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", "fixture 0.1.7"], {
      cwd: originWork,
      quiet: true,
    });

    await run("npm", ["install"], { cwd: installRoot, quiet: true });
    await run("node", ["scripts/configure-local-plugin.mjs", installRoot], { cwd: installRoot, quiet: true });
    await mkdir(codexHome, { recursive: true });
    await mkdir(planbanHome, { recursive: true });
    await run("codex", ["plugin", "marketplace", "add", installRoot], {
      cwd: installRoot,
      env: { CODEX_HOME: codexHome },
      quiet: true,
    });
    await run("codex", ["plugin", "add", "planban@planban"], {
      cwd: installRoot,
      env: { CODEX_HOME: codexHome },
      quiet: true,
    });

    const before = await versionFrom(installRoot);
    const update = await run("node", [
      "scripts/update-local-install.mjs",
      "--execute",
      "--target-version",
      "0.1.7",
      "--target-ref",
      "main",
      "-o",
      "json",
    ], {
      cwd: installRoot,
      env: {
        CODEX_HOME: codexHome,
        PLANBAN_HOME: planbanHome,
        PLANBAN_DISABLE_AUTO_RESTART: "1",
      },
      quiet: true,
    });
    const updateSnapshot = JSON.parse(update.stdout);
    if (updateSnapshot.status !== "succeeded") {
      throw new Error(updateSnapshot.error ?? "Direct update harness update did not succeed");
    }
    const after = await versionFrom(installRoot);
    const marker = await readFile(join(installRoot, "DIRECT_UPDATE_HARNESS_MARKER.txt"), "utf8");

    if (before.version !== "0.1.6") throw new Error(`Expected starting version 0.1.6, got ${before.version}`);
    if (after.version !== "0.1.7") throw new Error(`Expected updated version 0.1.7, got ${after.version}`);
    if (marker.trim() !== "updated") throw new Error("Updated marker file was not installed");

    process.stdout.write(JSON.stringify({
      ok: true,
      before: before.version,
      after: after.version,
      installRoot,
      codexHome,
      planbanHome,
      kept: keep,
    }, null, 2) + "\n");
  } finally {
    if (!keep) await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
