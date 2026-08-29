import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

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
