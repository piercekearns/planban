import assert from "node:assert/strict";
import test from "node:test";
import { overflowMarqueeMetrics } from "../src/web/OverflowMarqueeText";

test("keeps text stationary when it fits in the available width", () => {
  assert.deepEqual(overflowMarqueeMetrics(160, 140, 13), {
    distance: 0,
    durationMs: 0,
    overflowing: false,
  });
});

test("treats sub-pixel measurement differences as non-overflowing", () => {
  assert.deepEqual(overflowMarqueeMetrics(160, 160.5, 13), {
    distance: 0,
    durationMs: 0,
    overflowing: false,
  });
});

test("moves overflowing text at two ems per second", () => {
  assert.deepEqual(overflowMarqueeMetrics(120, 172, 13), {
    distance: 52,
    durationMs: 2_000,
    overflowing: true,
  });
});
