#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = { fromVersion: null, expectedVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-version") options.fromVersion = argv[++index] ?? null;
    else if (arg === "--expected-version") options.expectedVersion = argv[++index] ?? null;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.fromVersion) throw new Error("--from-version is required");
  if (!options.expectedVersion) throw new Error("--expected-version is required");
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout.trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const options = parseArgs(process.argv.slice(2));
const candidateSha = run("git", ["rev-parse", "HEAD"]);
const sourceUrl = run("git", ["remote", "get-url", "origin"]);
const rehearsalRoot = await mkdtemp(join(tmpdir(), "planban-release-upgrade-"));

try {
  const oldRoot = join(rehearsalRoot, "old");
  const candidateRemote = join(rehearsalRoot, "candidate.git");
  const codexHome = join(rehearsalRoot, "codex-home");
  const planbanHome = join(rehearsalRoot, "planban-home");
  const projectRoot = join(rehearsalRoot, "project");
  const env = { CODEX_HOME: codexHome, PLANBAN_HOME: planbanHome };

  await Promise.all([mkdir(codexHome), mkdir(planbanHome), mkdir(projectRoot)]);
  run("git", ["clone", "--quiet", "--branch", `v${options.fromVersion}`, sourceUrl, oldRoot]);
  run("git", ["clone", "--quiet", "--bare", repoRoot, candidateRemote]);
  run("git", ["update-ref", "refs/heads/release-candidate", candidateSha], { cwd: candidateRemote });
  run("git", ["remote", "set-url", "origin", candidateRemote], { cwd: oldRoot });

  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: oldRoot });
  run("codex", ["plugin", "marketplace", "add", oldRoot], { env });
  run("codex", ["plugin", "add", "planban@planban"], { env });
  run("node", ["scripts/configure-local-plugin.mjs", oldRoot], { cwd: oldRoot });
  run("node", ["--import", "tsx/esm", "src/cli.ts", "init", "--cwd", projectRoot,
    "--repo-id", "release-upgrade-rehearsal", "--title", "Release upgrade rehearsal", "--no-agents"], {
    cwd: oldRoot,
    env,
  });

  run("node", ["scripts/update-local-install.mjs", "--execute",
    "--target-version", options.expectedVersion, "--target-ref", "release-candidate"], {
    cwd: oldRoot,
    env,
  });

  const updatedSha = run("git", ["rev-parse", "HEAD"], { cwd: oldRoot });
  const packageJson = await readJson(join(oldRoot, "package.json"));
  const cachedCreateSkill = await readFile(join(
    codexHome,
    "plugins/cache/planban/planban",
    options.expectedVersion,
    "skills/planban-create/SKILL.md",
  ), "utf8");
  const status = JSON.parse(run("node", ["--import", "tsx/esm", "src/cli.ts", "status", "--cwd", projectRoot], {
    cwd: oldRoot,
    env,
  }));

  if (updatedSha !== candidateSha) throw new Error(`updated HEAD ${updatedSha} does not match candidate ${candidateSha}`);
  if (packageJson.version !== options.expectedVersion) {
    throw new Error(`updated package version ${packageJson.version} does not match ${options.expectedVersion}`);
  }
  if (!status.initialized || !status.roadmapExists || status.repoId !== "release-upgrade-rehearsal") {
    throw new Error("device-local board did not survive the release upgrade rehearsal");
  }
  if (status.version?.version !== options.expectedVersion) {
    throw new Error(`updated runtime version ${status.version?.version ?? "missing"} does not match ${options.expectedVersion}`);
  }
  if (
    !/verified Board\s+URL once/iu.test(cachedCreateSkill)
    || !/clickable verified URL|verified URL\s+as a clickable Markdown link/iu.test(cachedCreateSkill)
    || !/## Post-creation handoff[\s\S]{0,240}new Planban board or project setup[\s\S]{0,120}one or more Work\s+Items/iu.test(cachedCreateSkill)
  ) {
    throw new Error("updated installed plugin cache is missing the post-mutation Board handoff contract");
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    fromVersion: options.fromVersion,
    expectedVersion: options.expectedVersion,
    candidateSha,
    boardPreserved: true,
    cachedGuidanceVerified: true,
  }, null, 2) + "\n");
} finally {
  await rm(rehearsalRoot, { recursive: true, force: true });
}
