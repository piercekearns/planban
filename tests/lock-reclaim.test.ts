import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("processes that find a killed process's lock at the same time never hold it together", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  try {
    const planningRoot = join(root, "board");
    // A lock left by a process that has since exited.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolveExit) => dead.once("exit", resolveExit));
    await mkdir(join(planningRoot, ".planban-write.lock"), { recursive: true });
    await writeFile(join(planningRoot, ".planban-write.lock", "owner.json"), JSON.stringify({ pid: dead.pid, token: "dead", queue: true, createdAt: new Date().toISOString() }));
    // And the queue entries of a process killed while waiting and while holding.
    await mkdir(join(planningRoot, ".planban-write.queue"), { recursive: true });
    await writeFile(join(planningRoot, ".planban-write.queue", "choosing-00000000-0000-4000-8000-000000000001.json"), JSON.stringify({ pid: dead.pid }));
    await writeFile(join(planningRoot, ".planban-write.queue", "ticket-000000000001-00000000-0000-4000-8000-000000000002.json"), JSON.stringify({ pid: dead.pid }));
    const log = join(root, "log.txt");
    const script = join(root, "hold.mjs");
    await writeFile(script, `
      import { appendFile } from "node:fs/promises";
      const { withBoardWriteLock } = await import(${JSON.stringify(resolve("src/core/persistence.ts"))});
      await withBoardWriteLock(${JSON.stringify(planningRoot)}, async () => {
        await appendFile(${JSON.stringify(log)}, "enter\\n");
        await new Promise((r) => setTimeout(r, 150));
        await appendFile(${JSON.stringify(log)}, "exit\\n");
      });
    `);
    await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, ["--import", "tsx/esm", script])));
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(lines.length, 8);
    for (let index = 0; index < lines.length; index += 2) assert.deepEqual(lines.slice(index, index + 2), ["enter", "exit"], `overlap in ${lines.join(",")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old lock whose holder is still alive is never taken away", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  try {
    const planningRoot = join(root, "board");
    const lock = join(planningRoot, ".planban-write.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: holder.pid, token: "alive", queue: true, createdAt: new Date(0).toISOString() }));
    await mkdir(join(planningRoot, ".planban-write.queue"), { recursive: true });
    await writeFile(join(planningRoot, ".planban-write.queue", "ticket-000000000001-00000000-0000-4000-8000-000000000003.json"), JSON.stringify({ pid: holder.pid }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, old, old);
    const { withBoardWriteLock } = await import("../src/core/persistence");
    let entered = false;
    const waiting = withBoardWriteLock(planningRoot, async () => { entered = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    assert.equal(entered, false, "the live holder's lock was taken");
    holder.kill("SIGKILL");
    await new Promise((resolveExit) => holder.once("exit", resolveExit));
    await waiting;
    assert.equal(entered, true);
    // The lock an older Planban version would hold, recently refreshed, is respected too.
    const legacy = join(root, "legacy-board");
    await mkdir(join(legacy, ".planban-write.lock"), { recursive: true });
    await writeFile(join(legacy, ".planban-write.lock", "owner.json"), JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }));
    let enteredLegacy = false;
    const legacyWaiting = withBoardWriteLock(legacy, async () => { enteredLegacy = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    assert.equal(enteredLegacy, false, "an older version's fresh lock was taken");
    await rm(join(legacy, ".planban-write.lock"), { recursive: true, force: true });
    await legacyWaiting;
    assert.equal(enteredLegacy, true);
    assert.equal(entered, true);
  } finally {
    holder.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("many processes taking turns on one board never overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  try {
    const planningRoot = join(root, "board");
    const log = join(root, "log.txt");
    const script = join(root, "turns.mjs");
    await writeFile(script, `
      import { appendFile } from "node:fs/promises";
      const { withBoardWriteLock } = await import(${JSON.stringify(resolve("src/core/persistence.ts"))});
      for (let turn = 0; turn < 3; turn += 1) {
        await withBoardWriteLock(${JSON.stringify(planningRoot)}, async () => {
          await appendFile(${JSON.stringify(log)}, "enter\\n");
          await new Promise((r) => setTimeout(r, 20));
          await appendFile(${JSON.stringify(log)}, "exit\\n");
        });
      }
    `);
    await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, ["--import", "tsx/esm", script])));
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(lines.length, 48);
    for (let index = 0; index < lines.length; index += 2) assert.deepEqual(lines.slice(index, index + 2), ["enter", "exit"], `overlap at ${index}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a write blocked by a stuck process says which process holds the board and how to free it", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const env = { ...process.env, PLANBAN_HOME: home, PLANBAN_LOCK_WAIT_MS: "1500" };
  const cli = (args: string[]) => execFileAsync(process.execPath, ["--import", "tsx/esm", resolve("src/cli.ts"), ...args], { env });
  try {
    await cli(["init", "--cwd", project, "--repo-id", "stuck-board", "--no-agents", "-o", "json"]);
    const planningRoot = join(home, "repos", "stuck-board");
    // A process that takes the board and then hangs.
    const script = join(root, "hang.mjs");
    await writeFile(script, `
      const { withBoardWriteLock } = await import(${JSON.stringify(resolve("src/core/persistence.ts"))});
      await withBoardWriteLock(${JSON.stringify(planningRoot)}, async () => { console.log("holding"); await new Promise(() => { setInterval(() => {}, 1000); }); });
    `);
    const holder = spawn(process.execPath, ["--import", "tsx/esm", script, "hung-agent-marker"], { env });
    await new Promise<void>((resolveHeld) => holder.stdout.once("data", () => resolveHeld()));
    try {
      const failure = await cli(["create-card", "Blocked", "--cwd", project, "-o", "json"]).then(() => null, (error) => error);
      assert.ok(failure, "the write should give up");
      assert.match(failure.stderr, new RegExp(`held by process ${holder.pid}`));
      assert.match(failure.stderr, /hung-agent-marker/);
      assert.match(failure.stderr, new RegExp(`kill ${holder.pid}`));
      assert.match(failure.stderr, /nothing was changed/);
      // An agent going through the local MCP server gets the same explanation.
      const mcp = spawn(process.execPath, ["plugins/planban/scripts/start-planban-mcp.mjs"], {
        env: { ...env, PLANBAN_REPO_ROOT: resolve("."), PLANBAN_ACTIVITY_URL: "http://127.0.0.1:9" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      mcp.stdout.on("data", (chunk) => { output += chunk; });
      const done = new Promise<void>((resolveDone) => mcp.once("exit", () => resolveDone()));
      mcp.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "planban_create_card", arguments: { cwd: project, title: "From an agent" } } }) + "\n");
      await done;
      assert.match(output, new RegExp(`held by process ${holder.pid}`));
      assert.match(output, new RegExp(`kill ${holder.pid}`));
    } finally {
      const exited = holder.exitCode !== null || holder.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => holder.once("exit", resolveExit));
      holder.kill("SIGKILL");
      await exited;
    }
    const created = JSON.parse((await cli(["create-card", "Unblocked", "--cwd", project, "-o", "json"])).stdout);
    assert.ok(JSON.stringify(created).includes("Unblocked"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
