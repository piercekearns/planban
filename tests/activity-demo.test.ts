import assert from "node:assert/strict";
import test from "node:test";
import {
  activityLabIsEnabled,
  activityVariantForIndex,
  simulatedActivityBurst,
  strongestActivityPhase,
} from "../src/web/activityDemo.js";

test("activity lab is isolated to the registered demo board and explicit query", () => {
  assert.equal(activityLabIsEnabled("planban-demo", "demo", "?activityLab=1"), true);
  assert.equal(activityLabIsEnabled("planban-demo", "demo", ""), false);
  assert.equal(activityLabIsEnabled("project", "project", "?activityLab=1"), false);
});

test("activity variants repeat deterministically", () => {
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => activityVariantForIndex(index)),
    ["illumination", "aurora", "threads", "currents", "luminous-seam", "illumination", "aurora"],
  );
});

test("rollup phase resolution favours genuinely active descendants", () => {
  assert.equal(strongestActivityPhase(["fading", "cooldown", "active"]), "active");
  assert.equal(strongestActivityPhase([null, "fading"]), "fading");
  assert.equal(strongestActivityPhase([]), null);
});

test("simulated bursts stay within the visual test cadence", () => {
  const values = [0.2, 0.4, 0.7, 0.3, 0.9, 0.5, 0.25, 0.75];
  let index = 0;
  const burst = simulatedActivityBurst(() => values[index++ % values.length]!);
  assert.ok(burst.operationOffsetsMs.length >= 2 && burst.operationOffsetsMs.length <= 4);
  assert.equal(burst.operationOffsetsMs.length, burst.operationDurationsMs.length);
  assert.ok(burst.operationOffsetsMs.every((offset) => offset >= 0 && offset < 400));
  assert.ok(burst.operationDurationsMs.every((duration) => duration >= 35 && duration <= 185));
  assert.ok(burst.nextBurstDelayMs >= 1500 && burst.nextBurstDelayMs <= 4300);
});
