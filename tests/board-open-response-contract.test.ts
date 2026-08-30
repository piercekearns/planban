import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function read(relativePath: string) {
  return await readFile(resolve(repoRoot, relativePath), "utf8");
}

function assertAlwaysLinkedContract(markdown: string, source: string) {
  assert.match(
    markdown,
    /must include (?:that |the )?exact verified URL as a clickable Markdown link|must include the exact verified board URL as a clickable Markdown link/iu,
    `${source} must require the exact verified clickable URL`,
  );
  assert.match(
    markdown,
    /even when (?:automatic )?in-app browser (?:opening|presentation) succeeds|regardless of whether in-app browser presentation succeeds/iu,
    `${source} must retain the link after successful browser presentation`,
  );
}

test("all canonical board-opening skills require a clickable URL on success", async () => {
  const sources = [
    "plugins/planban/skills/pb/SKILL.md",
    "plugins/planban/skills/planban/SKILL.md",
    "plugins/planban/skills/planban-tutorial/SKILL.md",
    "plugins/planban/skills/planban/references/planban-protocol.md",
  ];

  for (const source of sources) {
    assertAlwaysLinkedContract(await read(source), source);
  }
});

test("the MCP launch tool reinforces the required user-reply URL", async () => {
  const server = await read("plugins/planban/mcp/server.mjs");
  assert.match(server, /userReplyRequiresUrl:\s*true/u);
  assert.match(server, /urlRequired:\s*true/u);
  assert.match(server, /\[Open the verified board\]\(\$\{url\}\)/u);
  assert.match(server, /Include this exact clickable URL in the user-facing confirmation even if the in-app browser opened successfully\./u);
});

function assertPostMutationHandoff(markdown: string, source: string) {
  assert.match(markdown, /complete logical mutation sequence|complete creation sequence/iu, `${source} must batch the handoff after the logical mutation`);
  assert.match(markdown, /verified Board\s+URL once/iu, `${source} must resolve the Board URL once`);
  assert.match(markdown, /one bounded (?:in-app presentation|open-or-focus|attempt to open or focus)/iu, `${source} must bound browser presentation`);
  assert.match(markdown, /clickable verified URL|verified URL\s+as a clickable Markdown link/iu, `${source} must return the verified clickable URL`);
}

test("successful Planban mutations require one durable Board handoff", async () => {
  const planbanSkill = await read("plugins/planban/skills/planban/SKILL.md");
  const createSkill = await read("plugins/planban/skills/planban-create/SKILL.md");
  const protocol = await read("plugins/planban/skills/planban/references/planban-protocol.md");

  assertPostMutationHandoff(planbanSkill, "Planban skill");
  assertPostMutationHandoff(createSkill, "Planban Create skill");
  assertPostMutationHandoff(protocol, "Planban protocol");
  assert.match(
    createSkill,
    /## Post-creation handoff[\s\S]{0,240}new Planban board or project setup[\s\S]{0,120}one or more Work\s+Items/iu,
    "Planban Create must hand off both new boards/projects and new Work Items",
  );
  assert.match(protocol, /headless or background operation may skip browser presentation/iu);
  assert.match(protocol, /Browser-presentation failure does not invalidate a successful mutation/iu);
  assert.match(protocol, /Do not reopen the Board after every storage write/iu);
});
