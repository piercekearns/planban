import assert from "node:assert/strict";
import test from "node:test";
import { combineBenchmarks, evaluateBenchmark } from "../scripts/assert-update-performance.mjs";

function benchmark(reuseMedian = 600) {
  return {
    ok: true,
    environment: { platform: "test", architecture: "test", node: "v24" },
    summary: {
      baseline: { medianEndToEndMs: 1_000 },
      reuse: { medianEndToEndMs: reuseMedian },
    },
    samples: [
      { mode: "baseline", sample: 1, runtime: { dependencyMode: "clean-install" }, boardPreserved: true, updatedCommit: "abc" },
      { mode: "reuse", sample: 1, runtime: { dependencyMode: "reused" }, boardPreserved: true, updatedCommit: "abc" },
    ],
  };
}

const options = { iterations: 1, minimumImprovement: 0.2, expectedCommit: "abc" };

test("combines distinct runner shards from raw measurements and rejects incompatible evidence", () => {
  const shards = Array.from({ length: 5 }, (_, index) => ({
    ...benchmark(),
    shardId: String(index + 1),
    expectedCommit: "abc",
    samples: benchmark().samples.map((sample) => ({
      ...sample,
      endToEndDurationMs: sample.mode === "baseline" ? 1000 + index : 600 + index,
    })),
  }));
  const combined = combineBenchmarks(shards);
  assert.equal(combined.summary.baseline.medianEndToEndMs, 1002);
  assert.equal(combined.summary.reuse.medianEndToEndMs, 602);
  assert.equal(evaluateBenchmark(combined, { ...options, iterations: 5 }).ok, true);
  assert.equal(evaluateBenchmark(combineBenchmarks(shards.slice(1)), { ...options, iterations: 5 }).ok, false);
  assert.throws(() => combineBenchmarks([shards[0], shards[0]]), /duplicate/i);
  assert.throws(() => combineBenchmarks([shards[0], { ...shards[1], expectedCommit: "wrong" }]), /incompatible/i);
  assert.throws(() => combineBenchmarks([shards[0], { ...shards[1], environment: { platform: "other" } }]), /incompatible/i);
  assert.throws(() => combineBenchmarks([shards[0], { ...shards[1], ok: false }]), /unsuccessful/i);
  assert.throws(() => combineBenchmarks([{ ...shards[0], samples: [] }]), /pair/i);
});

test("accepts a verified relative marketplace speed improvement", () => {
  assert.deepEqual(evaluateBenchmark(benchmark(), options), {
    ok: true,
    errors: [],
    platform: "test",
    architecture: "test",
    node: "v24",
    expectedCommit: "abc",
    baselineMedianMs: 1_000,
    reuseMedianMs: 600,
    improvementPercent: 40,
  });
});

test("rejects a missing reuse path, wrong commit, lost Board, or weak improvement", () => {
  const input = benchmark(900);
  input.samples[1].runtime.dependencyMode = "clean-install";
  input.samples[1].boardPreserved = false;
  input.samples[1].updatedCommit = "wrong";
  const result = evaluateBenchmark(input, options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /did not reuse|lost Board|installed wrong|below 20\.0%/u);
});

test("upgrade correctness allows changed dependencies without weakening the compatible-update speed gate", () => {
  const input = benchmark(1200);
  Object.assign(input.samples[1].runtime, {
    dependencyMode: "clean-install",
    dependencyReason: "dependency-fingerprint-or-runtime-changed",
  });
  assert.equal(evaluateBenchmark(input, { ...options, correctnessOnly: true }).ok, true);
  assert.equal(evaluateBenchmark(input, options).ok, false);
  Object.assign(input.samples[1].runtime, { dependencyReason: "reuse-verification-failed" });
  assert.equal(evaluateBenchmark(input, { ...options, correctnessOnly: true }).ok, false);
  input.samples[1].boardPreserved = false;
  input.samples[1].updatedCommit = "wrong";
  const result = evaluateBenchmark(input, { ...options, correctnessOnly: true });
  assert.match(result.errors.join("\n"), /lost Board/u);
  assert.match(result.errors.join("\n"), /installed wrong/u);
});
