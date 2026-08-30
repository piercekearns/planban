import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildAgentContext } from "../src/core/protocol";

const repoRoot = process.cwd();

function source(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("the bundled Planban house style is the single runtime authoring reference", () => {
  const houseStyle = source("plugins/planban/skills/planban/references/planban-house-style.md");
  const protocol = source("plugins/planban/skills/planban/references/planban-protocol.md");
  const createSkill = source("plugins/planban/skills/planban-create/SKILL.md");

  for (const heading of ["## Information locations and ownership", "### Summary", "### Next action", "### Spec", "### Plan"]) {
    assert.match(houseStyle, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(protocol, /read `planban-house-style\.md` completely/u);
  assert.match(createSkill, /read\s+`\.\.\/planban\/references\/planban-house-style\.md` completely/u);
});

test("generated agent context invokes the installed policy without copying it", () => {
  const context = buildAgentContext({
    planningRoot: "/tmp/planban/repos/example",
    roadmapPath: "/tmp/planban/repos/example/roadmap.json",
    manifestPath: "/tmp/example/.planban/project.json",
  });

  assert.match(context, /installed Planban protocol and Planban house style/u);
  assert.doesNotMatch(context, /Information locations and ownership/u);
});
