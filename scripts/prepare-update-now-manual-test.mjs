#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  const options = {
    port: 4329,
    keep: false,
    oldVersion: "0.1.6",
    newVersion: "0.1.7",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      options.port = Number(argv[++index] ?? options.port);
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--old-version") {
      options.oldVersion = argv[++index] ?? options.oldVersion;
    } else if (arg === "--new-version") {
      options.newVersion = argv[++index] ?? options.newVersion;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error("--port must be a positive integer");
  return options;
}

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
  release.summary = "Manual Update now test release.";
  release.updatePrompt = "Update Planban through the manual Update now test fixture.";
  release.postUpdateRoute = "board-with-changelog";
  release.changelogTitle = "Manual Update now test";
  release.changelogSummary = "This temporary release proves the one-click local updater can update, verify, restart, and reopen a board.";
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

  const mcpServerPath = join(root, "plugins/planban/mcp/server.mjs");
  if (existsSync(mcpServerPath)) {
    const mcpServerSource = readFileSync(mcpServerPath, "utf8")
      .replace(/const SERVER_VERSION = "([^"]+)";/u, "const SERVER_VERSION = PLANBAN_MCP_VERSION;");
    await writeFile(mcpServerPath, mcpServerSource, "utf8");
  }
}

function startManifestServer(manifest) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(manifest));
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("Could not start manifest server");
      resolveListen({
        server,
        url: `http://127.0.0.1:${address.port}/latest.json`,
      });
    });
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitForStatus(baseUrl, expectedVersion, timeoutMs = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await fetchJson(`${baseUrl}/api/status`);
      if (!expectedVersion || status.version?.version === expectedVersion) return status;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ${baseUrl}/api/status`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(tmpdir(), "planban-update-now-manual-"));
  const releaseRoot = join(tempRoot, "release-source");
  const originWork = join(tempRoot, "origin-work");
  const installRoot = join(tempRoot, "install-root");
  const codexHome = join(tempRoot, "codex-home");
  const planbanHome = join(tempRoot, "planban-home");
  const projectRoot = join(tempRoot, "project");
  const restartPidFile = join(tempRoot, "restart.pid");
  let appProcess = null;
  let manifestServer = null;
  let shuttingDown = false;

  async function cleanup() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (appProcess && !appProcess.killed) appProcess.kill("SIGTERM");
    const restartedPid = Number(await readFile(restartPidFile, "utf8").catch(() => ""));
    if (restartedPid) {
      try {
        process.kill(restartedPid, "SIGTERM");
      } catch {
        // The restarted server may already be stopped.
      }
    }
    if (manifestServer) {
      await new Promise((resolveClose) => manifestServer.close(() => resolveClose()));
    }
    if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
  }

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(143));
  });

  try {
    await run("node", ["scripts/build-public-release.mjs", releaseRoot], { quiet: true });
    await cp(releaseRoot, originWork, { recursive: true });

    await patchVersion(originWork, options.oldVersion, options.newVersion);
    await run("git", ["init", "-b", "main"], { cwd: originWork, quiet: true });
    await run("git", ["add", "."], { cwd: originWork, quiet: true });
    await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", `fixture ${options.oldVersion}`], {
      cwd: originWork,
      quiet: true,
    });

    await run("git", ["clone", originWork, installRoot], { quiet: true });

    await patchVersion(originWork, options.newVersion, options.newVersion);
    await writeFile(join(originWork, "UPDATE_NOW_MANUAL_TEST_MARKER.txt"), "updated\n", "utf8");
    await run("git", ["add", "."], { cwd: originWork, quiet: true });
    await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", `fixture ${options.newVersion}`], {
      cwd: originWork,
      quiet: true,
    });

    await mkdir(codexHome, { recursive: true });
    await mkdir(planbanHome, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await run("npm", ["install"], { cwd: installRoot, quiet: true });
    await run("node", ["scripts/configure-local-plugin.mjs", installRoot], { cwd: installRoot, quiet: true });
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
    await run("node", ["bin/planban.mjs", "init", "--cwd", projectRoot, "--title", "Update Now Test", "--repo-id", "update-now-test", "--no-agents"], {
      cwd: installRoot,
      env: { PLANBAN_HOME: planbanHome },
      quiet: true,
    });

    const manifest = await readJson(join(originWork, "release/latest.json"));
    const manifestHandle = await startManifestServer(manifest);
    manifestServer = manifestHandle.server;

    const env = {
      CODEX_HOME: codexHome,
      PLANBAN_HOME: planbanHome,
      PLANBAN_UPDATE_MANIFEST_URL: manifestHandle.url,
      PLANBAN_RESTART_PID_FILE: restartPidFile,
    };
    appProcess = spawn(process.execPath, ["bin/planban.mjs", "serve", "--cwd", projectRoot, "--port", String(options.port)], {
      cwd: installRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    appProcess.stdout.setEncoding("utf8");
    appProcess.stderr.setEncoding("utf8");

    const baseUrl = `http://localhost:${options.port}`;
    const boardUrl = `${baseUrl}/boards/update-now-test`;
    await waitForStatus(baseUrl, options.oldVersion);
    const updateStatus = await fetchJson(`${baseUrl}/api/update-status`);
    const preflight = await fetchJson(`${baseUrl}/api/update-preflight`);
    if (!updateStatus.updateAvailable || updateStatus.latest?.version !== options.newVersion) {
      throw new Error(`Expected update status to report ${options.newVersion}`);
    }
    if (!preflight.directUpdateAvailable) {
      throw new Error(`Expected direct update to be available: ${preflight.blockedReasons?.join("; ")}`);
    }

    const info = {
      ok: true,
      oldVersion: options.oldVersion,
      newVersion: options.newVersion,
      boardUrl,
      tempRoot,
      installRoot,
      originWork,
      codexHome,
      planbanHome,
      projectRoot,
      manifestUrl: manifestHandle.url,
      cleanup: "Stop this terminal process to remove the temporary test install.",
    };
    await writeJson(join(tempRoot, "manual-test-info.json"), info);
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    process.stdout.write("\nManual Update now test is running. Press Ctrl-C to stop and clean up.\n");

    await new Promise(() => {
      // Keep the fake release manifest alive while the user tests the local app.
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
