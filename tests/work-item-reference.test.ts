import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildWorkItemReference, planbanReference } from "../src/web/workItemReference";
import { buildAgentContext } from "../src/core/protocol";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("Copy Reference produces one line: quoted title then an exact planban reference", () => {
  assert.equal(planbanReference("planban"), "planban:planban");
  assert.equal(planbanReference("planban", "add-portable-planban-references"), "planban:planban/add-portable-planban-references");
  const line = buildWorkItemReference("shopify-fabric-theme", { id: "make-mimeeq-garments-accurate", title: "Make MIMEeq garments accurate" });
  assert.equal(line, "“Make MIMEeq garments accurate” · planban:shopify-fabric-theme/make-mimeeq-garments-accurate");
  assert.doesNotMatch(line, /\n|Local Board ID|Item ID/u);
});

test("every host sees how to read and write planban references", async () => {
  const context = buildAgentContext({ repoId: "demo", planningRoot: "/tmp/demo", roadmapPath: "/tmp/demo/roadmap.json", manifestPath: "/tmp/repo/.planban/project.json" });
  assert.match(context, /planban:<board>\/<item>/u);
  assert.match(context, /the id is the identity/u);
  assert.match(context, /planban_get_card/u);

  const server = await readFile(resolve(repoRoot, "plugins/planban/mcp/server.mjs"), "utf8");
  assert.match(server, /A planban:<board>\/<item> token is a Planban reference/u);

  const protocol = await readFile(resolve(repoRoot, "plugins/planban/skills/planban/references/planban-protocol.md"), "utf8");
  assert.match(protocol, /## Planban references/u);
  assert.match(protocol, /Trust the id over the title/u);
  assert.match(protocol, /Writing a reference/u);

  const help = await readFile(resolve(repoRoot, "plugins/planban/skills/planban-help/SKILL.md"), "utf8");
  assert.match(help, /planban:<board>\/<item>/u);

  const web = await readFile(resolve(repoRoot, "src/web/main.tsx"), "utf8");
  assert.doesNotMatch(web, /Local Board ID/u);
  assert.match(web, /buildWorkItemReference\(state\.manifest\.repoId, item\)/u);
});
