#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = { file: null, expectedCommit: null, iterations: 5, minimumImprovement: 0.2 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") options.file = argv[++index] ?? "";
    else if (arg === "--expected-commit") options.expectedCommit = argv[++index] ?? "";
    else if (arg === "--iterations") options.iterations = Number(argv[++index]);
    else if (arg === "--minimum-improvement") options.minimumImprovement = Number(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.file) throw new Error("--file is required");
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!(options.minimumImprovement >= 0 && options.minimumImprovement < 1)) {
    throw new Error("--minimum-improvement must be between 0 and 1");
  }
  return options;
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
    if (sample.runtime?.dependencyMode !== "reused") {
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
  else if (improvement < options.minimumImprovement) {
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
  const benchmark = JSON.parse(await readFile(options.file, "utf8"));
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
