#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { updateMarketplaceRuntime } from "./update-marketplace-runtime.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {
    fromVersion: "1.1.2",
    expectedVersion: "1.1.3",
    iterations: 3,
    mode: "both",
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-version") options.fromVersion = argv[++index] ?? "";
    else if (arg === "--expected-version") options.expectedVersion = argv[++index] ?? "";
    else if (arg === "--iterations") options.iterations = Number(argv[++index]);
    else if (arg === "--mode") options.mode = argv[++index] ?? "";
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.fromVersion || !options.expectedVersion) throw new Error("Version arguments cannot be empty");
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!["baseline", "reuse", "both"].includes(options.mode)) {
    throw new Error("--mode must be baseline, reuse, or both");
  }
  return options;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      const result = { exitCode: code ?? 1, stdout, stderr, durationMs: performance.now() - startedAt };
      if (result.exitCode !== 0 && !options.allowFailure) {
        const detail = (stderr || stdout).trim();
        rejectRun(new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`));
        return;
      }
      resolveRun(result);
    });
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function marketplaceRoot(codexHome, env) {
  const listed = await run("codex", ["plugin", "marketplace", "list", "--json"], { env });
  const parsed = JSON.parse(listed.stdout);
  const marketplace = parsed.marketplaces?.find(({ name }) => name === "planban");
  if (!marketplace?.root) throw new Error(`Planban marketplace root missing in ${codexHome}`);
  return marketplace.root;
}

async function pointMarketplaceAtMain(codexHome) {
  const configPath = join(codexHome, "config.toml");
  const config = await readFile(configPath, "utf8");
  const updated = config.replace(/^ref\s*=\s*"[^"]+"\s*$/mu, 'ref = "main"');
  if (updated === config) throw new Error("Could not change isolated marketplace ref to main");
  await writeFile(configPath, updated, "utf8");
}

async function runSample(options, mode, sampleNumber, sharedNpmCache) {
  const sampleRoot = await mkdtemp(join(tmpdir(), `planban-update-${mode}-`));
  const codexHome = join(sampleRoot, "codex-home");
  const planbanHome = join(sampleRoot, "planban-home");
  const projectRoot = join(sampleRoot, "project");
  const env = {
    CODEX_HOME: codexHome,
    PLANBAN_HOME: planbanHome,
    npm_config_cache: sharedNpmCache,
  };
  const setupStartedAt = performance.now();

  try {
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(planbanHome, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    await run("codex", ["plugin", "marketplace", "add", "https://github.com/piercekearns/planban.git",
      "--ref", `v${options.fromVersion}`], { env });
    const root = await marketplaceRoot(codexHome, env);
    await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, env });
    await run("node", ["--import", "tsx/esm", "src/cli.ts", "init", "--cwd", projectRoot,
      "--repo-id", "update-performance-rehearsal", "--title", "Update performance rehearsal", "--no-agents"], {
      cwd: root,
      env,
    });
    await run("node", ["--import", "tsx/esm", "src/cli.ts", "create-card", "Update proof",
      "--status", "pending", "--cwd", projectRoot, "--output", "json"], { cwd: root, env });
    await pointMarketplaceAtMain(codexHome);
    const setupDurationMs = performance.now() - setupStartedAt;

    const updateStartedAt = performance.now();
    const runtime = await updateMarketplaceRuntime({
      root,
      codexHome,
      disableReuse: mode === "baseline",
    });
    const configure = await run("node", ["scripts/configure-local-plugin.mjs", root], { cwd: root, env });
    const plugin = await run("codex", ["plugin", "add", "planban@planban"], { cwd: root, env });
    const verify = await run("node", ["--import", "tsx/esm", "scripts/verify-local-install.mjs",
      "--root", root, "--expected-version", options.expectedVersion, "--codex-home", codexHome], {
      cwd: root,
      env,
    });
    const status = await run("node", ["--import", "tsx/esm", "src/cli.ts", "status", "--cwd", projectRoot], {
      cwd: root,
      env,
    });
    const card = await run("node", ["--import", "tsx/esm", "src/cli.ts", "get-card", "update-proof",
      "--cwd", projectRoot, "--output", "json"], { cwd: root, env });
    const endToEndDurationMs = performance.now() - updateStartedAt;
    const parsedStatus = JSON.parse(status.stdout);
    const parsedCard = JSON.parse(card.stdout);
    if (parsedStatus.version?.version !== options.expectedVersion || parsedCard.id !== "update-proof") {
      throw new Error("Updated runtime failed the persisted Board readiness check");
    }

    return {
      mode,
      sample: sampleNumber,
      setupDurationMs: Math.round(setupDurationMs),
      runtime,
      postRefreshMs: {
        configure: Math.round(configure.durationMs),
        plugin: Math.round(plugin.durationMs),
        verify: Math.round(verify.durationMs),
        boardReadiness: Math.round(status.durationMs + card.durationMs),
      },
      endToEndDurationMs: Math.round(endToEndDurationMs),
      boardPreserved: true,
    };
  } finally {
    if (!options.keep) await rm(sampleRoot, { recursive: true, force: true });
    else process.stderr.write(`Preserved rehearsal at ${sampleRoot}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const benchmarkRoot = await mkdtemp(join(tmpdir(), "planban-update-benchmark-"));
  const sharedNpmCache = join(benchmarkRoot, "npm-cache");
  const modes = options.mode === "both" ? ["baseline", "reuse"] : [options.mode];
  const samples = [];
  try {
    await mkdir(sharedNpmCache, { recursive: true });
    for (const mode of modes) {
      for (let sample = 1; sample <= options.iterations; sample += 1) {
        process.stderr.write(`Running ${mode} sample ${sample}/${options.iterations}...\n`);
        const result = await runSample(options, mode, sample, sharedNpmCache);
        samples.push(result);
        process.stderr.write(`  ${result.endToEndDurationMs}ms (${result.runtime.dependencyMode})\n`);
      }
    }
    const summary = Object.fromEntries(modes.map((mode) => {
      const modeSamples = samples.filter((sample) => sample.mode === mode);
      return [mode, {
        samples: modeSamples.length,
        medianRuntimeMs: Math.round(median(modeSamples.map((sample) => sample.runtime.durationMs))),
        medianEndToEndMs: Math.round(median(modeSamples.map((sample) => sample.endToEndDurationMs))),
        minEndToEndMs: Math.min(...modeSamples.map((sample) => sample.endToEndDurationMs)),
        maxEndToEndMs: Math.max(...modeSamples.map((sample) => sample.endToEndDurationMs)),
      }];
    }));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      fromVersion: options.fromVersion,
      expectedVersion: options.expectedVersion,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        sharedNpmCacheAcrossSamples: true,
        isolatedCodexHomePerSample: true,
        isolatedPlanbanHomePerSample: true,
      },
      summary,
      samples,
    }, null, 2)}\n`);
  } finally {
    if (!options.keep) await rm(benchmarkRoot, { recursive: true, force: true });
    else process.stderr.write(`Preserved benchmark cache at ${benchmarkRoot}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
