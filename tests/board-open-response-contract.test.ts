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

const boardOpeningSources = [
  "plugins/planban/skills/pb/SKILL.md",
  "plugins/planban/skills/planban/SKILL.md",
  "plugins/planban/skills/planban-tutorial/SKILL.md",
  "plugins/planban/skills/planban/references/planban-protocol.md",
];

function hostAdapters(markdown: string, source: string) {
  const start = markdown.search(/^#{2,3} Host adapters$/mu);
  assert.ok(start >= 0, `${source} must have a Host adapters section`);
  return { before: markdown.slice(0, start), adapters: markdown.slice(start) };
}

test("all canonical board-opening skills require a clickable URL on success", async () => {
  for (const source of boardOpeningSources) {
    assertAlwaysLinkedContract(await read(source), source);
  }
});

test("board-opening guidance keeps a host-neutral critical path with per-host adapters", async () => {
  for (const source of boardOpeningSources) {
    const markdown = await read(source);
    const { before, adapters } = hostAdapters(markdown, source);

    assert.match(adapters, /^#{3,4} Codex desktop$/mu, `${source} must keep a Codex adapter`);
    assert.match(adapters, /^#{3,4} Claude Code desktop$/mu, `${source} must have a Claude Code adapter`);
    assert.match(adapters, /^#{3,4} Other hosts$/mu, `${source} must cover hosts without an adapter`);
    assert.match(adapters, /built-in browser pane[\s\S]{0,120}navigate tool/u, `${source} must describe the Claude Code capability first`);
    assert.match(adapters, /mcp__Claude_Browser__navigate/u, `${source} must hint at the current Claude Code tool name`);
    assert.match(adapters, /Make one attempt/u, `${source} must bound the Claude Code attempt`);

    const genericPath = before.replace(/^Codex invokes these as .*$/mu, "");
    assert.doesNotMatch(genericPath, /Codex|node_repl|openUrlInCodexBrowser/u, `${source} must keep host names out of the critical path`);
    assert.match(before, /in-app presentation attempt/u, `${source} must make presentation one bounded adapter step`);
  }
});

test("the Codex adapter keeps the existing Node REPL opener rules", async () => {
  for (const source of [
    "plugins/planban/skills/pb/SKILL.md",
    "plugins/planban/skills/planban/SKILL.md",
    "plugins/planban/skills/planban/references/planban-protocol.md",
  ]) {
    const { adapters } = hostAdapters(await read(source), source);
    const codex = adapters.slice(adapters.search(/^#{3,4} Codex desktop$/mu), adapters.search(/^#{3,4} Claude Code desktop$/mu));
    assert.match(codex, /openUrlInCodexBrowser/u, `${source} Codex adapter must keep the opener`);
    assert.match(codex, /at most one tool-discovery (?:call|attempt)/u, `${source} Codex adapter must keep one discovery attempt`);
    assert.match(codex, /Codex browser\s+bridge\s+(?:as\s+)?unavailable|"Codex browser bridge\s+unavailable"/u, `${source} Codex adapter must keep the bridge-unavailable rule`);
    assert.match(codex, /openPlanbanBoardInCodexBrowser/u, `${source} Codex adapter must keep its fallbacks`);
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
