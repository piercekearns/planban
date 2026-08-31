import assert from "node:assert/strict";
import test from "node:test";
import {
  activityPhaseAt,
  PLANBAN_ACTIVITY_HOLD_MS,
  PLANBAN_ACTIVITY_LEASE_TTL_MS,
  PLANBAN_ACTIVITY_TAIL_MS,
  PlanbanActivityStore,
} from "../src/core/activity";

test("coalesces overlapping activity leases for one Work Item", () => {
  const store = new PlanbanActivityStore();
  store.begin({ repoId: "demo", cardId: "card", leaseId: "one", now: 100 });
  store.begin({ repoId: "demo", cardId: "card", leaseId: "two", now: 120 });
  assert.equal(store.snapshot(130)[0]?.activeCount, 2);
  store.end({ repoId: "demo", cardId: "card", leaseId: "one", now: 140 });
  assert.equal(store.snapshot(150)[0]?.activeCount, 1);
  store.end({ repoId: "demo", cardId: "card", leaseId: "two", now: 160 });
  assert.deepEqual(store.snapshot(160)[0], {
    repoId: "demo",
    cardId: "card",
    activeCount: 0,
    lastStartedAt: 120,
    endedAt: 160,
    removeAt: 160 + PLANBAN_ACTIVITY_TAIL_MS,
  });
});

test("retains fast completed access through cooldown and fade", () => {
  const store = new PlanbanActivityStore();
  store.begin({ repoId: "demo", cardId: "card", leaseId: "fast", now: 1_000 });
  store.end({ repoId: "demo", cardId: "card", leaseId: "fast", now: 1_010 });
  const activity = store.snapshot(1_010)[0]!;
  assert.equal(activityPhaseAt(activity, 1_010 + PLANBAN_ACTIVITY_HOLD_MS - 1), "cooldown");
  assert.equal(activityPhaseAt(activity, 1_010 + PLANBAN_ACTIVITY_HOLD_MS), "fading");
  assert.equal(store.snapshot(1_010 + PLANBAN_ACTIVITY_TAIL_MS).length, 0);
});

test("a renewed lease cancels an in-progress exit", () => {
  const store = new PlanbanActivityStore();
  store.begin({ repoId: "demo", cardId: "card", leaseId: "first", now: 0 });
  store.end({ repoId: "demo", cardId: "card", leaseId: "first", now: 20 });
  store.begin({ repoId: "demo", cardId: "card", leaseId: "second", now: 500 });
  assert.equal(activityPhaseAt(store.snapshot(500)[0]!, 500), "active");
  assert.equal(store.snapshot(500)[0]?.removeAt, null);
});

test("expires abandoned leases and then removes their visual tail", () => {
  const store = new PlanbanActivityStore();
  store.begin({ repoId: "demo", cardId: "card", leaseId: "lost", now: 0 });
  assert.equal(store.prune(PLANBAN_ACTIVITY_LEASE_TTL_MS), true);
  const expired = store.snapshot(PLANBAN_ACTIVITY_LEASE_TTL_MS)[0]!;
  assert.equal(expired.activeCount, 0);
  assert.equal(expired.endedAt, PLANBAN_ACTIVITY_LEASE_TTL_MS);
  assert.equal(store.snapshot(PLANBAN_ACTIVITY_LEASE_TTL_MS + PLANBAN_ACTIVITY_TAIL_MS).length, 0);
});
