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
