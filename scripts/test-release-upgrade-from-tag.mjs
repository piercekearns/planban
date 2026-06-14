#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertPortClosed, terminateChild, terminatePid } from "./process-cleanup.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  const options = {
    from: "v0.1.7",
    expected: null,
    keep: false,
    openEventStream: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") {
      options.from = argv[++index] ?? options.from;
    } else if (arg === "--expected") {
      options.expected = argv[++index] ?? options.expected;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--no-event-stream") {
      options.openEventStream = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

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
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
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

async function assertReleaseVersion(root, expected, label) {
  const packageJson = await readJson(join(root, "package.json"));
  const release = await readJson(join(root, "release/latest.json"));
  const plugin = await readJson(join(root, "plugins/planban/.codex-plugin/plugin.json"));
  const mismatches = [];
  if (packageJson.version !== expected) mismatches.push(`package.json=${packageJson.version}`);
  if (release.version !== expected) mismatches.push(`release/latest.json=${release.version}`);
  if (release.pluginVersion !== expected) mismatches.push(`release pluginVersion=${release.pluginVersion}`);
  if (release.mcpVersion !== expected) mismatches.push(`release mcpVersion=${release.mcpVersion}`);
  if (plugin.version !== expected) mismatches.push(`plugin.json=${plugin.version}`);
  if (mismatches.length > 0) {
    throw new Error(`${label} expected ${expected}: ${mismatches.join(", ")}`);
  }
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

async function waitForStatus(baseUrl, predicate, timeoutMs = 45000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await fetchJson(`${baseUrl}/api/status`);
      if (predicate(status)) return status;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ${baseUrl}/api/status`);
}

function startManifestServer(manifest) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(manifest));
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("Could not start manifest server");
      resolveListen({ server, url: `http://127.0.0.1:${address.port}/latest.json` });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(tmpdir(), "planban-real-upgrade-"));
  const oldRoot = join(tempRoot, "old-release");
  const candidateRoot = join(tempRoot, "candidate-release");
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
    await run("git", ["clone", "--depth", "1", "--branch", options.from, "https://github.com/piercekearns/planban.git", oldRoot], { quiet: true });
    await run("node", ["scripts/build-public-release.mjs", candidateRoot], { quiet: true });

    const candidateManifest = await readJson(join(candidateRoot, "release/latest.json"));
    const expectedVersion = options.expected ?? candidateManifest.version;
    await assertReleaseVersion(candidateRoot, expectedVersion, "candidate release");

    await cp(oldRoot, originWork, { recursive: true });
    await rm(join(originWork, ".git"), { recursive: true, force: true });
    await run("git", ["init", "-b", "main"], { cwd: originWork, quiet: true });
    await run("git", ["add", "."], { cwd: originWork, quiet: true });
    await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", `fixture ${options.from}`], {
      cwd: originWork,
      quiet: true,
    });

    await run("git", ["clone", originWork, installRoot], { quiet: true });

    await run("rsync", ["-a", "--checksum", "--delete", "--exclude", ".git", `${candidateRoot}/`, `${originWork}/`], { quiet: true });
    await assertReleaseVersion(originWork, expectedVersion, "candidate fixture");
    await run("git", ["add", "-A"], { cwd: originWork, quiet: true });
    await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", `candidate ${expectedVersion}`], {
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
    await run("node", ["bin/planban.mjs", "init", "--cwd", projectRoot, "--title", "Real Upgrade Harness", "--repo-id", "real-upgrade-harness", "--no-agents"], {
      cwd: installRoot,
      env: { PLANBAN_HOME: planbanHome },
      quiet: true,
    });

    const manifestHandle = await startManifestServer(candidateManifest);
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

    const before = await waitForStatus(baseUrl, (status) => status.version?.version !== expectedVersion);
    const updateStatus = await fetchJson(`${baseUrl}/api/update-status`);
    if (!updateStatus.updateAvailable || updateStatus.latest?.version !== expectedVersion) {
      throw new Error(`Expected update status to report ${expectedVersion}, got ${JSON.stringify(updateStatus)}`);
    }

    let eventReader = null;
    if (options.openEventStream) {
      const eventStream = await fetch(`${baseUrl}/api/events`);
      if (!eventStream.ok || !eventStream.body) throw new Error("Could not open update event stream");
      eventReader = eventStream.body.getReader();
    }

    const job = await fetchJson(`${baseUrl}/api/update-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentBoardUrl: `${baseUrl}/boards/real-upgrade-harness` }),
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
    await eventReader?.cancel().catch(() => {});
    if (finalJob?.status !== "succeeded") {
      throw new Error(finalJob?.error ?? "Update job did not succeed before restart");
    }

    const after = await waitForStatus(baseUrl, (status) => status.version?.version === expectedVersion, 60000);
    const pidText = await readFile(restartPidFile, "utf8").catch(() => "");
    restartedPid = Number(pidText.trim()) || null;

    process.stdout.write(JSON.stringify({
      ok: true,
      from: options.from,
      before: before.version.version,
      after: after.version.version,
      expected: expectedVersion,
      installRoot,
      codexHome,
      planbanHome,
      projectRoot,
      kept: options.keep,
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
      if (port) await assertPortClosed(port, `Planban rehearsal port ${port}`, 10000);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (manifestServer) await new Promise((resolveClose) => manifestServer.close(() => resolveClose()));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (!options.keep) await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const message = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
      if (runError) process.stderr.write(`Cleanup after failed rehearsal also failed: ${message}\n`);
      else throw new Error(`Release upgrade rehearsal cleanup failed: ${message}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
