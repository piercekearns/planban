#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { terminatePid, assertPortClosed } from "./process-cleanup.mjs";

const source = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "planban cold install "));
const codexHome = join(root, "codex home");
const runtime = join(codexHome, ".tmp/marketplaces/planban");
const version = JSON.parse(await readFile(join(source, "package.json"), "utf8")).version;
const cache = join(codexHome, "plugins/cache/planban/planban", version);
const env = { ...process.env, CODEX_HOME: codexHome, PLANBAN_HOME: join(root, "board data") };
delete env.PLANBAN_REPO_ROOT;
delete env.PLANBAN_LAUNCH_LOG_FILE;
delete env.PLANBAN_RESTART_PID_FILE;
let serverPid = null;
let port = null;

function run(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: cache, env, encoding: "utf8", timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024, ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

try {
  await mkdir(runtime, { recursive: true });
  for (const path of ["package.json", "package-lock.json", "bin", "src", "plugins", "scripts", "dist", "release"]) {
    await cp(join(source, path), join(runtime, path), { recursive: true });
  }
  await cp(join(runtime, "plugins/planban"), cache, { recursive: true });
  // Use the shipped config, without running configure-local-plugin first.
  const config = JSON.parse(await readFile(join(cache, ".mcp.json"), "utf8")).mcpServers.planban;
  assert.equal(config.cwd, ".");
  const handshake = () => run(config.args[0], config.args.slice(1), {
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n',
  });
  const coldMcp = handshake();
  const messages = coldMcp.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(messages.find(({ id }) => id === 1)?.result?.serverInfo?.version, version);
  assert.ok(messages.find(({ id }) => id === 2)?.result?.tools?.some(({ name }) => name === "planban_get_board"));
  assert.match(coldMcp.stderr, /preparing runtime dependencies/u);

  const project = join(root, "project");
  run(join(runtime, "bin/planban.mjs"), ["init", "--cwd", project, "--repo-id", "cold-install", "--no-agents"]);
  // Exercise the board launcher with dependencies absent too. No inherited runtime override.
  await rm(join(runtime, "node_modules"), { recursive: true, force: true });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, "127.0.0.1", done));
  port = socket.address().port;
  await new Promise((done, fail) => socket.close((error) => error ? fail(error) : done()));
  const pidFile = join(root, "server.pid");
  const launch = run(join(cache, "scripts/launch-planban.mjs"), ["--cwd", project, "--port", String(port), "--no-vite"], {
    env: { ...env, PLANBAN_RESTART_PID_FILE: pidFile },
  });
  serverPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  assert.match(launch.stderr, /preparing runtime dependencies/u);
  const url = `http://127.0.0.1:${port}/boards/cold-install`;
  assert.ok(launch.stdout.includes(url), launch.stdout);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root"><\/div>/u);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/boards/cold-install/health`)).json()).ok, true);
  assert.equal(handshake().stderr, "", "warm MCP startup should not reinstall dependencies");
  await terminatePid(serverPid, "cold install server");
  serverPid = null;
  await assertPortClosed(port, "cold install server");
  await rm(join(runtime, "node_modules"), { recursive: true, force: true });
  const coldCli = run(join(runtime, "bin/planban.mjs"), ["status", "--cwd", project]);
  assert.equal(JSON.parse(coldCli.stdout).version.version, version);
  assert.match(coldCli.stderr, /preparing runtime dependencies/u);
  process.stdout.write(JSON.stringify({ ok: true, version, coldMcp: true, coldLauncher: true, coldCli: true, urlVerified: true, pathsWithSpaces: true }) + "\n");
} finally {
  if (serverPid) await terminatePid(serverPid, "cold install server");
  if (port) await assertPortClosed(port, "cold install server");
  await rm(root, { recursive: true, force: true });
}
