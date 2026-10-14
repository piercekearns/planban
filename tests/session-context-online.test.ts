import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planbanSessionContext } from "../plugins/planban/scripts/claude-session-context.mjs";

async function project(manifest: Record<string, unknown>, note = false) {
  const dir = await mkdtemp(join(tmpdir(), "planban-session-"));
  await mkdir(join(dir, ".planban"), { recursive: true });
  await writeFile(join(dir, ".planban/project.json"), JSON.stringify({ repoId: "demo", ...manifest }));
  if (note) await writeFile(join(dir, ".planban/online-board.json"), "{}");
  return dir;
}

test("the session-start line says when the board is online, or read-only because it went online elsewhere", async () => {
  const online = await project({ storage: { kind: "online", url: "https://app.planban.example", boardId: "demo" } });
  const stale = await project({ storage: { kind: "local" } }, true);
  const local = await project({ storage: { kind: "local" } });
  try {
    assert.match(planbanSessionContext({ projectDir: online }) ?? "", /This board is online at https:\/\/app\.planban\.example: read and edit it only through the Planban tools/);
    assert.match(planbanSessionContext({ projectDir: stale }) ?? "", /taken online on another computer, so this copy is read-only/);
    const plain = planbanSessionContext({ projectDir: local }) ?? "";
    assert.doesNotMatch(plain, /online/);
  } finally {
    for (const dir of [online, stale, local]) await rm(dir, { recursive: true, force: true });
  }
});
