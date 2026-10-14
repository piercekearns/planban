import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcp } from "../online/service/convex/model/mcp";

const roadmap: any = {
  revision: 3, project: { id: "deadleg", title: "Deadleg" }, updatedAt: new Date().toISOString(),
  roadmapItems: [{ id: "vest", title: "Choose the vest supplier", status: "in-progress", summary: "Two suppliers left.", nextAction: "Owner: pick one.", tags: [], metadata: {}, isGroup: false, parentId: null, priority: 1 }],
};
const service: any = {
  listBoards: async () => [{ boardId: "deadleg", title: "Deadleg" }],
  getBoard: async () => roadmap,
  readDoc: async () => ({ markdown: "## Purpose\nOne supplier for 300 units." }),
};
const call = async (name: string, args: Record<string, unknown>) => {
  const response = await handleMcp(new Request("https://app.planban.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), service, "https://app.planban.example");
  return (await response.json()).result;
};

test("search and fetch cite each card's address on the web page", async () => {
  const link = "https://app.planban.example/boards/deadleg#card=vest";
  const search = await call("search", { query: "vest" });
  assert.equal(search.isError, false);
  assert.deepEqual(search.structuredContent.results, [{ id: "deadleg/vest", title: "Choose the vest supplier (Deadleg)", url: link }]);
  const fetched = await call("fetch", { id: "deadleg/vest" });
  assert.equal(fetched.isError, false);
  assert.equal(fetched.structuredContent.url, link);
  assert.equal(fetched.structuredContent.title, "Choose the vest supplier");
  assert.match(fetched.structuredContent.text, /One supplier for 300 units/);
});
