import assert from "node:assert/strict";
import test from "node:test";
import {
  activityTargetForTool,
  planbanActivityBaseUrl,
  startPlanbanMcpActivity,
} from "../plugins/planban/mcp/activity.mjs";

test("targets only direct single-Work-Item MCP operations", () => {
  assert.equal(activityTargetForTool("planban_get_card", { cardId: "alpha" }), "alpha");
  assert.equal(activityTargetForTool("planban_write_doc", { cardId: "alpha", kind: "spec" }), "alpha");
  assert.equal(activityTargetForTool("planban_query_cards", { cardId: "alpha" }), null);
  assert.equal(activityTargetForTool("planban_create_card", { title: "Alpha" }), null);
});

test("publishes matched start and end leases to the local activity bridge", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const activity = await startPlanbanMcpActivity({
    name: "planban_update_card",
    args: { cardId: "alpha" },
    env: { PLANBAN_ACTIVITY_URL: "http://127.0.0.1:4999" },
    leaseId: "lease",
    resolveBoard: async () => ({ repoId: "demo" }),
    fetchImpl: async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 202 });
    },
  });
  assert.ok(activity);
  await activity.end();
  await activity.end();
  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:4999/api/boards/demo/activity/start", body: { cardId: "alpha", leaseId: "lease" } },
    { url: "http://127.0.0.1:4999/api/boards/demo/activity/end", body: { cardId: "alpha", leaseId: "lease" } },
  ]);
});

test("activity publication is best effort and local-only", async () => {
  const activity = await startPlanbanMcpActivity({
    name: "planban_get_card",
    args: { cardId: "alpha" },
    resolveBoard: async () => ({ repoId: "demo" }),
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(activity, null);
  assert.throws(() => planbanActivityBaseUrl({ PLANBAN_ACTIVITY_URL: "https://example.com" }), /local HTTP URL/u);
});
