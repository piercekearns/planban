#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = { files: [], expectedCommit: null, iterations: 5, minimumImprovement: 0.2, correctnessOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--correctness-only") options.correctnessOnly = true;
    else if (arg === "--file") options.files.push(argv[++index] ?? "");
    else if (arg === "--expected-commit") options.expectedCommit = argv[++index] ?? "";
    else if (arg === "--iterations") options.iterations = Number(argv[++index]);
    else if (arg === "--minimum-improvement") options.minimumImprovement = Number(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.files.length || options.files.some((file) => !file)) throw new Error("--file is required");
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!(options.minimumImprovement >= 0 && options.minimumImprovement < 1)) {
    throw new Error("--minimum-improvement must be between 0 and 1");
  }
  return options;
}

export function combineBenchmarks(benchmarks) {
  const first = benchmarks[0];
  if (!first) throw new Error("No benchmark shards supplied");
  const ids = new Set();
  const samples = [];
  for (const benchmark of benchmarks) {
    if (!benchmark.shardId || ids.has(benchmark.shardId)) throw new Error("Missing or duplicate shard id");
    ids.add(benchmark.shardId);
    if (benchmark.ok !== true) throw new Error("Unsuccessful benchmark shard");
    for (const field of ["expectedCommit", "fromRef", "sourceUrl", "targetSourceUrl", "targetRef", "expectedVersion"]) {
      if (benchmark[field] !== first[field]) throw new Error(`Incompatible shard ${field}`);
    }
    for (const field of ["platform", "architecture", "node"]) {
      if (benchmark.environment?.[field] !== first.environment?.[field]) throw new Error(`Incompatible shard ${field}`);
    }
    if (benchmark.samples?.length !== 2
      || benchmark.samples.filter(({ mode }) => mode === "baseline").length !== 1
      || benchmark.samples.filter(({ mode }) => mode === "reuse").length !== 1) {
      throw new Error("Each shard must contain one clean/reuse pair");
    }
    for (const sample of benchmark.samples) {
      if (!Number.isFinite(sample.endToEndDurationMs) || sample.endToEndDurationMs <= 0) {
        throw new Error("Invalid shard sample duration");
      }
      samples.push({ ...sample, sample: benchmark.shardId });
    }
  }
  const summary = Object.fromEntries(["baseline", "reuse"].map((mode) => {
    const values = samples.filter((sample) => sample.mode === mode)
      .map((sample) => sample.endToEndDurationMs).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return [mode, { medianEndToEndMs: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 }];
  }));
  return { ...first, samples, summary };
}

export function evaluateBenchmark(benchmark, options) {
  const errors = [];
  const baseline = benchmark.samples?.filter(({ mode }) => mode === "baseline") ?? [];
  const reuse = benchmark.samples?.filter(({ mode }) => mode === "reuse") ?? [];
  if (benchmark.ok !== true) errors.push("benchmark did not report success");
  if (baseline.length !== options.iterations) {
    errors.push(`expected ${options.iterations} baseline samples, received ${baseline.length}`);
  }
  if (reuse.length !== options.iterations) {
    errors.push(`expected ${options.iterations} reuse samples, received ${reuse.length}`);
  }
  for (const sample of baseline) {
    if (sample.runtime?.dependencyMode !== "clean-install") {
      errors.push(`baseline sample ${sample.sample} did not use clean install`);
    }
  }
  for (const sample of reuse) {
    const changedDependencies = options.correctnessOnly
      && sample.runtime?.dependencyMode === "clean-install"
      && sample.runtime?.dependencyReason === "dependency-fingerprint-or-runtime-changed";
    if (sample.runtime?.dependencyMode !== "reused" && !changedDependencies) {
      errors.push(`reuse sample ${sample.sample} did not reuse verified dependencies`);
    }
  }
  for (const sample of [...baseline, ...reuse]) {
    if (sample.boardPreserved !== true) errors.push(`${sample.mode} sample ${sample.sample} lost Board state`);
    if (options.expectedCommit && sample.updatedCommit !== options.expectedCommit) {
      errors.push(`${sample.mode} sample ${sample.sample} installed ${sample.updatedCommit ?? "no commit"}`);
    }
  }

  const baselineMedian = benchmark.summary?.baseline?.medianEndToEndMs;
  const reuseMedian = benchmark.summary?.reuse?.medianEndToEndMs;
  const improvement = Number.isFinite(baselineMedian) && Number.isFinite(reuseMedian) && baselineMedian > 0
    ? 1 - (reuseMedian / baselineMedian)
    : null;
  if (improvement === null) errors.push("benchmark medians are missing or invalid");
  else if (!options.correctnessOnly && improvement < options.minimumImprovement) {
    errors.push(`median improvement ${(improvement * 100).toFixed(1)}% is below ${(options.minimumImprovement * 100).toFixed(1)}%`);
  }

  return {
    ok: errors.length === 0,
    errors,
    platform: benchmark.environment?.platform ?? null,
    architecture: benchmark.environment?.architecture ?? null,
    node: benchmark.environment?.node ?? null,
    expectedCommit: options.expectedCommit,
    baselineMedianMs: baselineMedian ?? null,
    reuseMedianMs: reuseMedian ?? null,
    improvementPercent: improvement === null ? null : Number((improvement * 100).toFixed(1)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const benchmarks = await Promise.all(options.files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  const benchmark = benchmarks.length === 1 ? benchmarks[0] : combineBenchmarks(benchmarks);
  const result = evaluateBenchmark(benchmark, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
