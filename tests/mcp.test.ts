import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCard, createGroup as createGroupCore, historyPayload, initializeProject, loadState, readDoc, writeDoc } from "../src/core/storage";
import { PLANBAN_MCP_VERSION } from "../src/core/version";

const MCP_SERVER = join(process.cwd(), "plugins/planban/mcp/server.mjs");

function createGroup(input: Omit<Parameters<typeof createGroupCore>[0], "summary"> & { summary?: string }) {
  return createGroupCore({ ...input, summary: input.summary ?? `${input.title} objective` });
}

function runMcpServer(requests: unknown[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", MCP_SERVER], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      ...env,
      PLANBAN_REPO_ROOT: process.cwd(),
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 8_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function withPlanbanProject<T>(run: (input: { cwd: string; planbanHome: string; cardId: string }) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "planban-mcp-test-"));
  const cwd = join(root, "repo");
  const planbanHome = join(root, "home");
  const previousPlanbanHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = planbanHome;
  try {
    await initializeProject({ cwd, repoId: "mcp-test", title: "MCP Test", updateAgents: false });
    const created = await createGroup({
      cwd,
      title: "Alpha Card",
      status: "up-next",
      summary: "Initial summary",
      nextAction: "Initial next action",
    });
    const cardId = created.roadmap.roadmapItems.find((item) => item.title === "Alpha Card")?.id;
    assert.equal(cardId, "alpha-card");
    return await run({ cwd, planbanHome, cardId });
  } finally {
    if (previousPlanbanHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousPlanbanHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("Planban MCP server registers focused tools", () => {
  const responses = runMcpServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "planban-mcp-test", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  assert.equal(responses[0].result.serverInfo.name, "Planban MCP");
  assert.equal(responses[0].result.serverInfo.version, PLANBAN_MCP_VERSION);
  assert.match(responses[0].result.instructions, /Planban house style/u);
  const tools = responses[1].result.tools as Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }>;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "planban_status",
      "planban_list_boards",
      "planban_get_board",
      "planban_query_cards",
      "planban_get_card",
      "planban_create_card",
      "planban_create_group",
      "planban_create_cards",
      "planban_read_doc",
      "planban_move_card",
      "planban_update_card",
      "planban_write_doc",
      "planban_launch_board",
    ],
  );
  const queryProperties = tools.find((tool) => tool.name === "planban_query_cards")?.inputSchema.properties ?? {};
  assert.equal("programmeId" in queryProperties, false);
  assert.equal("programmeRole" in queryProperties, false);
  for (const toolName of ["planban_create_card", "planban_create_group", "planban_create_cards", "planban_update_card", "planban_write_doc"]) {
    assert.match(tools.find((tool) => tool.name === toolName)?.description ?? "", /Planban house style/u);
  }
});

test("Planban MCP exposes administration, maintenance, and legacy tools only through explicit profiles", () => {
  const responses = runMcpServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { PLANBAN_MCP_PROFILE: "admin,maintenance,legacy" });
  const names = (responses[1].result.tools as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of [
    "planban_archive_board",
    "planban_restore_board",
    "planban_duplicate_board",
    "planban_delete_board",
    "planban_export_flat_v1",
    "planban_reconstruct_hierarchy",
    "planban_set_card_parent",
  ]) assert.equal(names.includes(name), true, `${name} should be advertised by its explicit profile`);
  const reconstructionProperties = (responses[1].result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>)
    .find((tool) => tool.name === "planban_reconstruct_hierarchy")?.inputSchema.properties ?? {};
  assert.equal("programmes" in reconstructionProperties, false);
});

test("Planban MCP creates structured cards with docs and agent history", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_create_card",
          arguments: {
            cwd,
            title: "MCP Structured",
            status: "pending",
            position: "top",
            tags: ["mcp", "agent"],
            metadata: { source: "mcp-test" },
            specMarkdown: "# MCP Spec\n",
            planMarkdown: "# MCP Plan\n",
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    const card = responses[1].result.structuredContent.card;
    assert.equal(card.id, "mcp-structured");
    assert.equal(card.priority, 1);
    assert.deepEqual(card.tags, ["mcp", "agent"]);
    assert.deepEqual(card.metadata, { source: "mcp-test" });

    const spec = await readDoc({ cwd, cardId: "mcp-structured", kind: "spec" });
    const plan = await readDoc({ cwd, cardId: "mcp-structured", kind: "plan" });
    assert.equal(spec.markdown, "# MCP Spec\n");
    assert.equal(plan.markdown, "# MCP Plan\n");

    const history = await historyPayload(cwd);
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "card.create");
    assert.deepEqual(
      history.entries[0]?.affectedDocs.map((doc) => doc.kind),
      ["spec", "plan"],
    );
  });
});

test("Planban MCP board lifecycle tools require deliberate delete confirmation", async () => {
  await withPlanbanProject(async ({ planbanHome }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "planban_archive_board", arguments: { repoId: "mcp-test" } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planban_list_boards", arguments: { includeArchived: true } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "planban_restore_board", arguments: { repoId: "mcp-test" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "planban_duplicate_board",
          arguments: { sourceRepoId: "mcp-test", repoId: "mcp-test-copy", title: "MCP Test Copy" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "planban_delete_board", arguments: { repoId: "mcp-test", confirmRepoId: "wrong" } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "planban_delete_board", arguments: { repoId: "mcp-test", confirmRepoId: "mcp-test" } },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.board.repoId, "mcp-test");
    assert.equal(responses[2].result.structuredContent.boards[0].archivedAt !== null, true);
    assert.equal(responses[3].result.structuredContent.board.archivedAt, null);
    assert.equal(responses[4].result.structuredContent.board.repoId, "mcp-test-copy");
    assert.equal((await loadState(responses[4].result.structuredContent.board.cwd)).roadmap.project.title, "MCP Test Copy");
    assert.equal(responses[5].error.code, -32602);
    assert.match(responses[5].error.message, /confirmRepoId/);
    assert.equal(responses[6].result.structuredContent.repoId, "mcp-test");
    assert.match(responses[6].result.structuredContent.backupPath, /mcp-test/);
  });
});

test("Planban MCP read tools inspect boards, cards, and docs", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "planban_status", arguments: { cwd } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planban_get_card", arguments: { cwd, cardId } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "planban_read_doc", arguments: { cwd, cardId, kind: "spec" } },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.initialized, true);
    assert.equal(responses[2].result.structuredContent.card.title, "Alpha Card");
    assert.match(responses[3].result.structuredContent.markdown, /Alpha Card Spec/);
  });
});

test("Planban MCP status resolves a registered board by repoId", async () => {
  await withPlanbanProject(async ({ planbanHome }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "planban_status", arguments: { repoId: "mcp-test" } },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.initialized, true);
    assert.equal(responses[1].result.structuredContent.repoId, "mcp-test");
  });
});

test("Planban MCP queries owned Items without mutation", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    await createCard({ cwd, title: "Owned Result", parentId: cardId, nextAction: "Validate panel render", tags: ["visual"] });
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_query_cards",
          arguments: { cwd, search: "panel", projection: "main", hierarchyScope: "owned", tags: ["visual"] },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planban_query_cards", arguments: { cwd, statuses: ["pendng"] } },
      },
    ], { PLANBAN_HOME: planbanHome });
    const payload = responses[1].result.structuredContent;
    assert.deepEqual(payload.matches.map((entry: { item: { id: string } }) => entry.item.id), ["owned-result"]);
    assert.deepEqual(payload.context.map((entry: { item: { id: string } }) => entry.item.id), [cardId]);
    assert.equal(payload.revision, before.roadmap.revision);
    assert.equal((await loadState(cwd)).roadmap.revision, before.roadmap.revision);
    assert.equal(responses[2].error.code, -32602);
    assert.match(responses[2].error.message, /status|enum/i);
  });
});

test("Planban MCP reconstructs existing hierarchy and exports a recoverable flat board", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    await createCard({ cwd, title: "Existing Item", status: "pending" });
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "planban_reconstruct_hierarchy", arguments: { cwd, groups: [{ id: cardId, childIds: ["existing-item"] }], baseRevision: before.roadmap.revision },
      } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "planban_export_flat_v1", arguments: { cwd, exportId: "mcp-flat-v1" },
      } },
    ], { PLANBAN_HOME: planbanHome });
    assert.equal(responses[1].result.structuredContent.cards.find((item: { id: string }) => item.id === "existing-item").parentId, cardId);
    assert.equal(responses[2].result.structuredContent.exportId, "mcp-flat-v1");
  });
});

test("Planban MCP mutating tools move and update cards with agent history", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_move_card",
          arguments: { cwd, cardId, status: "in-progress", baseRevision: before.roadmap.revision },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "planban_update_card",
          arguments: {
            cwd,
            cardId,
            title: "Renamed through MCP",
            summary: "Updated through MCP",
            nextAction: "Review MCP update",
            tags: ["mcp"],
            blockedBy: null,
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.card.status, "in-progress");
    assert.equal(responses[2].result.structuredContent.card.summary, "Updated through MCP");
    assert.equal(responses[2].result.structuredContent.card.title, "Renamed through MCP");
    assert.deepEqual(responses[2].result.structuredContent.card.tags, ["mcp"]);

    const history = await historyPayload(cwd);
    assert.equal(history.entries[1]?.actor, "agent");
    assert.equal(history.entries[1]?.operation, "card.move");
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "card.update");
  });
});

test("Planban MCP creates a distinct Group from existing Items", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    await createCard({ cwd, title: "Panel-Aware", status: "in-progress" });
    await createCard({ cwd, title: "R-Logo", status: "up-next" });
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_create_group",
          arguments: {
            cwd,
            title: "MIMEeq Capability",
            itemIds: ["panel-aware", "r-logo"],
            anchorId: "panel-aware",
            baseRevision: before.roadmap.revision,
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.group.isGroup, true);
    assert.equal(responses[1].result.structuredContent.group.summary, null);
    const state = await loadState(cwd);
    assert.deepEqual(state.roadmap.roadmapItems.filter((item) => item.parentId === "mimeeq-capability").map((item) => item.id), ["panel-aware", "r-logo"]);
    const history = await historyPayload(cwd);
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "group.create");
  });
});

test("Planban MCP preserves the deprecated Programme creation alias", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    await createCard({ cwd, title: "Legacy Item", status: "up-next" });
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_create_programme",
          arguments: { cwd, title: "Legacy Group", summary: "Legacy compatibility", deliverableIds: ["legacy-item"] },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.group.isGroup, true);
    assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "legacy-item")?.parentId, "legacy-group");
  });
});

test("Planban MCP atomically creates multiple Group children", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "planban_create_cards", arguments: { cwd, titles: ["Product Authoring", "R-Logo"], parentId: cardId },
      } },
    ], { PLANBAN_HOME: planbanHome });
    assert.deepEqual(responses[1].result.structuredContent.cards.map((item: { title: string }) => item.title), ["Product Authoring", "R-Logo"]);
  });
});

test("Planban MCP creates inside, reparents, and reports ancestry", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    await createGroup({ cwd, title: "Second Group" });
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "planban_create_card", arguments: { cwd, title: "Nested Delivery", parentId: cardId },
      } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "planban_move_card", arguments: { cwd, cardId: "nested-delivery", parentId: "second-group" },
      } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name: "planban_get_card", arguments: { cwd, cardId: "nested-delivery" },
      } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: {
        name: "planban_move_card", arguments: { cwd, cardId: "nested-delivery", parentId: null },
      } },
    ], { PLANBAN_HOME: planbanHome });
    assert.equal(responses[1].result.structuredContent.card.parentId, cardId);
    assert.equal(responses[2].result.structuredContent.card.parentId, "second-group");
    assert.deepEqual(responses[3].result.structuredContent.ancestry.map((item: { id: string }) => item.id), ["second-group"]);
    assert.equal(responses[4].result.structuredContent.card.parentId, null);
  });
});

test("Planban MCP write doc uses stale protection and records agent history", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const before = await readDoc({ cwd, cardId, kind: "plan" });
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_write_doc",
          arguments: {
            cwd,
            cardId,
            kind: "plan",
            markdown: "# MCP Plan\n",
            expectedMtimeMs: before.mtimeMs,
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.exists, true);
    assert.equal(responses[1].result.structuredContent.markdown, "# MCP Plan\n");

    const history = await historyPayload(cwd);
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "doc.write");
  });
});

test("Planban MCP move card guards completion", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_move_card",
          arguments: { cwd, cardId, status: "complete" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "planban_move_card",
          arguments: { cwd, cardId, status: "complete", completionConfirmed: true },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].error.code, -32602);
    assert.match(responses[1].error.message, /completionConfirmed/);
    assert.equal(responses[2].result.structuredContent.card.status, "complete");
  });
});
