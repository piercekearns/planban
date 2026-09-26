// Resolve which directory owns the Planban project for a working directory.
//
// Agent hosts increasingly run sessions in linked git worktrees (Claude Code desktop, Codex
// worktrees) where the repo-local `.planban/` discovery files are absent because they are
// git-ignored. Planban board state is device-local and branch-independent, so the right
// board is the one owned by the repository's main checkout. This resolver is shared by the
// MCP server, the launchers, the session hook, and the TypeScript core.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MANIFEST = join(".planban", "project.json");

function hasManifest(dir) {
  return existsSync(join(dir, MANIFEST));
}

function readText(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

// For a linked worktree, `.git` is a file pointing at `<main>/.git/worktrees/<name>`, and that
// directory's `commondir` points back at the shared `<main>/.git`.
export function mainCheckoutForWorktree(gitTop) {
  const gitEntry = join(gitTop, ".git");
  let stats;
  try { stats = statSync(gitEntry); } catch { return null; }
  if (!stats.isFile()) return null;
  const pointer = readText(gitEntry);
  const match = pointer?.match(/^gitdir:\s*(.+)$/mu);
  if (!match) return null;
  const gitDir = resolve(gitTop, match[1].trim());
  const commonDirValue = readText(join(gitDir, "commondir"));
  const commonDir = commonDirValue
    ? (isAbsolute(commonDirValue) ? resolve(commonDirValue) : resolve(gitDir, commonDirValue))
    : resolve(gitDir, "../..");
  if (basename(commonDir) !== ".git") return null;
  return dirname(commonDir);
}

export function resolvePlanbanProjectDir(cwdInput) {
  const cwd = resolve(cwdInput);
  let dir = cwd;
  let gitTop = null;
  for (;;) {
    if (hasManifest(dir)) {
      return { projectDir: dir, requestedCwd: cwd, via: dir === cwd ? "cwd" : "ancestor" };
    }
    if (existsSync(join(dir, ".git"))) {
      gitTop = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (gitTop) {
    const mainCheckout = mainCheckoutForWorktree(gitTop);
    if (mainCheckout && mainCheckout !== gitTop && hasManifest(mainCheckout)) {
      return { projectDir: mainCheckout, requestedCwd: cwd, via: "worktree", worktreeDir: gitTop };
    }
  }
  return { projectDir: cwd, requestedCwd: cwd, via: "none" };
}

export function planbanProjectDir(cwdInput) {
  return resolvePlanbanProjectDir(cwdInput).projectDir;
}
