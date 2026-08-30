import assert from "node:assert/strict";
import test from "node:test";
import { groupAncestryForPrompt } from "../src/web/hierarchyPrompt";

test("formats the direct owning Group for Codex prompts", () => {
  const items = [
    { id: "capability", title: "MIMEeq Capability", parentId: null },
    { id: "delivery", title: "Authoring Delivery", parentId: "capability" },
  ];
  assert.equal(groupAncestryForPrompt(items, items[1]!), "MIMEeq Capability");
  assert.equal(groupAncestryForPrompt(items, items[0]!), "");
});
