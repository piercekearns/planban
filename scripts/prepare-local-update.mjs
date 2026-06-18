#!/usr/bin/env node
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SAFE_GENERATED_FILES = [
  ".codex-marketplace-install.json",
  "package-lock.json",
  "plugins/planban/.mcp.json",
];

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  const path = line.slice(3).trim();
  return {
    status,
    path: path.split(" -> ").at(-1) ?? path,
  };
}

async function git(args, cwd) {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024,
  });
}

async function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const status = await git(["status", "--porcelain", "--", ...SAFE_GENERATED_FILES], root);
  const changed = status.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseStatusLine);

  const tracked = changed
    .filter((entry) => entry.status !== "??")
    .map((entry) => entry.path);
  const untracked = changed
    .filter((entry) => entry.status === "??")
    .map((entry) => entry.path);

  if (tracked.length > 0) {
    await git(["checkout", "--", ...tracked], root);
  }

  for (const path of untracked) {
    await rm(resolve(root, path), { recursive: true, force: true });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    root,
    restored: tracked,
    removed: untracked,
  }, null, 2) + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
