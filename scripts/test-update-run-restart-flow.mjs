#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertPortClosed, terminateChild, terminatePid } from "./process-cleanup.mjs";

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
  release.summary = "Restart harness release.";
  release.updatePrompt = "Update Planban through the restart harness.";
  release.postUpdateRoute = "board-with-changelog";
  release.changelogTitle = "Restart harness";
  release.changelogSummary = "The endpoint update runner restarted into this release.";
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

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (!address || typeof address !== "object") throw new Error("Could not reserve a test port");
  return address.port;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitForStatus(url, predicate, timeoutMs = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await fetchJson(`${url}/api/status`);
      if (predicate(status)) return status;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}/api/status`);
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

async function main() {
  const keep = process.argv.includes("--keep");
  const tempRoot = await mkdtemp(join(tmpdir(), "planban-update-run-"));
  const releaseRoot = join(tempRoot, "release-source");
  const originWork = join(tempRoot, "origin-work");
  const installRoot = join(tempRoot, "install-root");
  const codexHome = join(tempRoot, "codex-home");
  const planbanHome = join(tempRoot, "planban-home");
  const projectRoot = join(tempRoot, "project");
  const restartPidFile = join(tempRoot, "restart.pid");
  let manifestServer = null;
  let serverProcess = null;
  let restartedPid = null;
  let port = null;
  let runError = null;

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
    await writeFile(join(originWork, "UPDATE_RUN_RESTART_MARKER.txt"), "restarted\n", "utf8");
    await run("git", ["add", "."], { cwd: originWork, quiet: true });
    await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", "fixture 0.1.7"], {
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
    await run("node", ["bin/planban.mjs", "init", "--cwd", projectRoot, "--title", "Restart Harness", "--repo-id", "restart-harness", "--no-agents"], {
      cwd: installRoot,
      env: { PLANBAN_HOME: planbanHome },
      quiet: true,
    });

    const manifest = await readJson(join(originWork, "release/latest.json"));
    const manifestHandle = await startManifestServer(manifest);
    manifestServer = manifestHandle.server;
    port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
      CODEX_HOME: codexHome,
      PLANBAN_HOME: planbanHome,
      PLANBAN_UPDATE_MANIFEST_URL: manifestHandle.url,
      PLANBAN_RESTART_PID_FILE: restartPidFile,
    };

    serverProcess = spawn(process.execPath, ["bin/planban.mjs", "serve", "--cwd", projectRoot, "--port", String(port), "--no-vite"], {
      cwd: installRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout.setEncoding("utf8");
    serverProcess.stderr.setEncoding("utf8");

    const before = await waitForStatus(baseUrl, (status) => status.version?.version === "0.1.6");
    const updateStatus = await fetchJson(`${baseUrl}/api/update-status`);
    if (!updateStatus.updateAvailable || updateStatus.latest?.version !== "0.1.7") {
      throw new Error("Expected fake manifest to report a 0.1.7 update");
    }

    const eventStream = await fetch(`${baseUrl}/api/events`);
    if (!eventStream.ok || !eventStream.body) {
      throw new Error("Could not open update restart event stream");
    }
    const eventReader = eventStream.body.getReader();

    const job = await fetchJson(`${baseUrl}/api/update-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentBoardUrl: `${baseUrl}/boards/restart-harness` }),
    });

    let finalJob = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        finalJob = await fetchJson(`${baseUrl}/api/update-run/${job.id}`);
        if (finalJob.status === "succeeded" || finalJob.status === "failed") break;
      } catch {
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    if (finalJob?.status !== "succeeded") {
      throw new Error(finalJob?.error ?? "Update job did not succeed before restart");
    }
    if (!finalJob.transcriptPath) {
      throw new Error("Update job did not report a transcript path");
    }
    const transcript = await readJson(finalJob.transcriptPath);
    if (transcript.status !== "succeeded") {
      throw new Error(`Expected succeeded transcript, got ${transcript.status}`);
    }
    if (!Array.isArray(transcript.steps) || transcript.steps.length === 0) {
      throw new Error("Update transcript did not record steps");
    }
    if (!transcript.steps.every((step) => step.status === "succeeded" && typeof step.durationMs === "number")) {
      throw new Error("Update transcript did not record successful step durations");
    }
    await eventReader.cancel().catch(() => {});

    const after = await waitForStatus(baseUrl, (status) => status.version?.version === "0.1.7", 45000);
    const marker = await readFile(join(installRoot, "UPDATE_RUN_RESTART_MARKER.txt"), "utf8");
    const pidText = await readFile(restartPidFile, "utf8").catch(() => "");
    restartedPid = Number(pidText.trim()) || null;

    if (marker.trim() !== "restarted") throw new Error("Restart harness marker was not installed");

    process.stdout.write(JSON.stringify({
      ok: true,
      before: before.version.version,
      after: after.version.version,
      installRoot,
      codexHome,
      planbanHome,
      projectRoot,
      kept: keep,
    }, null, 2) + "\n");
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      await terminateChild(serverProcess, "original Planban server");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await terminatePid(restartedPid, "restarted Planban server");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (port) await assertPortClosed(port, `Planban restart-flow port ${port}`, 10000);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (manifestServer) {
        await new Promise((resolveClose) => manifestServer.close(() => resolveClose()));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (!keep) await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const message = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
      if (runError) process.stderr.write(`Cleanup after failed restart-flow rehearsal also failed: ${message}\n`);
      else throw new Error(`Update-run restart-flow cleanup failed: ${message}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
