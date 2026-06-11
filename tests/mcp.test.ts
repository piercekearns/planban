import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCard, historyPayload, initializeProject, loadState, readDoc } from "../src/core/storage";

const MCP_SERVER = join(process.cwd(), "plugins/planban/mcp/server.mjs");

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
    const created = await createCard({
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
  assert.deepEqual(
    responses[1].result.tools.map((tool: { name: string }) => tool.name),
    [
      "planban_status",
      "planban_list_boards",
      "planban_archive_board",
      "planban_restore_board",
      "planban_delete_board",
      "planban_get_board",
      "planban_get_card",
      "planban_read_doc",
      "planban_move_card",
      "planban_update_card",
      "planban_write_doc",
      "planban_launch_board",
    ],
  );
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
        params: { name: "planban_delete_board", arguments: { repoId: "mcp-test", confirmRepoId: "wrong" } },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "planban_delete_board", arguments: { repoId: "mcp-test", confirmRepoId: "mcp-test" } },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.board.repoId, "mcp-test");
    assert.equal(responses[2].result.structuredContent.boards[0].archivedAt !== null, true);
    assert.equal(responses[3].result.structuredContent.board.archivedAt, null);
    assert.equal(responses[4].error.code, -32602);
    assert.match(responses[4].error.message, /confirmRepoId/);
    assert.equal(responses[5].result.structuredContent.repoId, "mcp-test");
    assert.match(responses[5].result.structuredContent.backupPath, /mcp-test/);
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
    assert.deepEqual(responses[2].result.structuredContent.card.tags, ["mcp"]);

    const history = await historyPayload(cwd);
    assert.equal(history.entries[1]?.actor, "agent");
    assert.equal(history.entries[1]?.operation, "card.move");
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "card.update");
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
