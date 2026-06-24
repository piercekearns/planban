#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { terminatePid, assertPortClosed, waitForChildExit } from "./process-cleanup.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  const options = {
    runtimeRoot: repoRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime-root") {
      options.runtimeRoot = resolve(argv[++index] ?? options.runtimeRoot);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  assert.equal(typeof address, "object");
  return address.port;
}

async function run(command, args, options = {}) {
  return await execFileAsync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 1024 * 1024,
    timeout: options.timeout ?? 20_000,
  });
}

async function startStalePlanbanServer(port, repoId) {
  const script = `
    const { createServer } = await import("node:http");
    const repoId = ${JSON.stringify(repoId)};
    const server = createServer((req, res) => {
      if (req.url === "/api/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ initialized: true, repoId, currentRepoId: repoId }));
        return;
      }
      if (req.url === "/api/boards") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ boards: [{ repoId, title: "Stale Planban" }] }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ENOENT: no such file or directory, open 'dist/web/index.html'" }));
    });
    server.listen(${JSON.stringify(port)}, "127.0.0.1", () => {
      process.stdout.write("ready\\n");
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  await new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(new Error(stderr.trim() || `Timed out waiting for stale server on port ${port}`));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onStdout = (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready")) {
        cleanup();
        resolveReady();
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk;
    };
    const onExit = (code) => {
      cleanup();
      rejectReady(new Error(stderr.trim() || `Stale server exited before ready with code ${code}`));
    };
    const onError = (error) => {
      cleanup();
      rejectReady(error);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });

  return child;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(join(options.runtimeRoot, "package.json"), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "planban-cache-launcher-"));
  const codexHome = join(root, "codex-home");
  const planbanHome = join(root, "planban-home");
  const projectRoot = join(root, "project");
  const marketplaceRoot = join(codexHome, ".tmp/marketplaces/planban");
  const cacheRoot = join(codexHome, "plugins/cache/planban/planban", packageJson.version);
  const pidFile = join(root, "planban.pid");
  const port = await freePort();
  const stalePort = await freePort();
  let serverPid = null;
  let staleRepairServerPid = null;
  let staleServer = null;

  try {
    await mkdir(dirname(marketplaceRoot), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await symlink(options.runtimeRoot, marketplaceRoot, "dir");
    await mkdir(cacheRoot, { recursive: true });
    await cp(join(options.runtimeRoot, "plugins/planban/scripts"), join(cacheRoot, "scripts"), { recursive: true });
    await writeFile(
      join(cacheRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          planban: {
            cwd: "__PLANBAN_REPO_ROOT__",
            command: "node",
            args: ["--import", "tsx/esm", "./plugins/planban/mcp/server.mjs"],
            env: { PLANBAN_REPO_ROOT: "__PLANBAN_REPO_ROOT__" },
          },
        },
      }, null, 2) + "\n",
      "utf8",
    );

    await run(process.execPath, [
      join(options.runtimeRoot, "bin/planban.mjs"),
      "init",
      "--cwd",
      projectRoot,
      "--repo-id",
      "cache-launcher-verify",
      "--title",
      "Cache Launcher Verify",
      "--no-agents",
    ], {
      cwd: options.runtimeRoot,
      env: { PLANBAN_HOME: planbanHome },
    });

    const launch = await run(process.execPath, [
      join(cacheRoot, "scripts/launch-planban.mjs"),
      "--cwd",
      projectRoot,
      "--port",
      String(port),
    ], {
      cwd: cacheRoot,
      env: {
        CODEX_HOME: codexHome,
        PLANBAN_HOME: planbanHome,
        PLANBAN_RESTART_PID_FILE: pidFile,
      },
    });

    assert.match(launch.stdout, new RegExp(`http://localhost:${port}/boards/cache-launcher-verify`, "u"));
    serverPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(Number.isInteger(serverPid) && serverPid > 0, "launcher should write a server PID");

    const response = await fetch(`http://localhost:${port}/boards/cache-launcher-verify`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="root"><\/div>/u);

    staleServer = await startStalePlanbanServer(stalePort, "cache-launcher-verify");
    const staleResponse = await fetch(`http://localhost:${stalePort}/boards/cache-launcher-verify`);
    assert.equal(staleResponse.status, 500);

    const staleRepairPidFile = join(root, "planban-stale-repair.pid");
    const staleRepairLaunch = await run(process.execPath, [
      join(cacheRoot, "scripts/launch-planban.mjs"),
      "--cwd",
      projectRoot,
      "--port",
      String(stalePort),
    ], {
      cwd: cacheRoot,
      env: {
        CODEX_HOME: codexHome,
        PLANBAN_HOME: planbanHome,
        PLANBAN_RESTART_PID_FILE: staleRepairPidFile,
      },
    });

    assert.match(staleRepairLaunch.stdout, new RegExp(`http://localhost:${stalePort}/boards/cache-launcher-verify`, "u"));
    staleRepairServerPid = Number.parseInt(await readFile(staleRepairPidFile, "utf8"), 10);
    assert.ok(Number.isInteger(staleRepairServerPid) && staleRepairServerPid > 0, "launcher should write a stale-repair server PID");

    const repairedResponse = await fetch(`http://localhost:${stalePort}/boards/cache-launcher-verify`);
    assert.equal(repairedResponse.status, 200);
    assert.match(await repairedResponse.text(), /<div id="root"><\/div>/u);
    assert.equal(await waitForChildExit(staleServer, 5000), true, "stale server should have been terminated by launcher health repair");

    process.stdout.write(JSON.stringify({
      ok: true,
      runtimeRoot: options.runtimeRoot,
      cacheRoot,
      marketplaceRoot,
      url: `http://localhost:${port}/boards/cache-launcher-verify`,
      staleRepairUrl: `http://localhost:${stalePort}/boards/cache-launcher-verify`,
    }, null, 2) + "\n");
  } finally {
    if (serverPid) await terminatePid(serverPid, "cache launcher verification server");
    if (staleRepairServerPid) await terminatePid(staleRepairServerPid, "cache launcher stale-repair verification server");
    if (staleServer?.pid) await terminatePid(staleServer.pid, "stale cache launcher verification server");
    await assertPortClosed(port, "cache launcher verification port");
    await assertPortClosed(stalePort, "cache launcher stale-repair verification port");
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
