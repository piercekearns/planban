#!/usr/bin/env node
// Claude Code SessionStart hook: when the project uses Planban, add one short orientation line to the session context.
// Output goes to stdout, which Claude Code adds as context. Never fail the session: exit 0 on any error.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePlanbanProjectDir } from "./project-dir.mjs";

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function planbanSessionContext({ projectDir: requestedDir, port = 4317 }) {
  const discovery = resolvePlanbanProjectDir(requestedDir);
  const projectDir = discovery.projectDir;
  const manifestPath = join(projectDir, ".planban/project.json");
  if (!existsSync(manifestPath)) return null;
  let repoId = null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    repoId = typeof manifest.repoId === "string" && manifest.repoId.trim() ? manifest.repoId.trim() : null;
  } catch {
    return null;
  }
  if (!repoId) return null;
  const boardUrl = `http://127.0.0.1:${port}/boards/${encodeURIComponent(repoId)}`;
  const where = discovery.via === "worktree"
    ? ` This session runs in a linked git worktree; the board belongs to the main checkout at ${projectDir}, and Planban resolves it automatically when you pass this worktree's path as \`cwd\`.`
    : "";
  return [
    `This project tracks its work in Planban (board \`${repoId}\`, usually ${boardUrl}).${where}`,
    "Read `.planban/agent-context.md` before reading or changing roadmap state, and use the Planban MCP tools (`planban_*`) with this repo's absolute path as `cwd`.",
    "After opening the board or finishing a batch of Planning changes, include the clickable verified board URL from the tool result in your reply.",
  ].join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  try {
    const input = readStdinJson();
    const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
    const context = planbanSessionContext({ projectDir: resolve(projectDir) });
    if (context) process.stdout.write(`${context}\n`);
  } catch {
    // Orientation is optional; never block the session.
  }
  process.exitCode = 0;
}
