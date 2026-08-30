import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function cliHelp(...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("current CLI help uses only Group and Item language", () => {
  const rootHelp = cliHelp("--help");
  assert.match(rootHelp, /create-group/);
  assert.doesNotMatch(rootHelp, /create-programme/);

  const createGroupHelp = cliHelp("create-group", "--help");
  assert.match(createGroupHelp, /--item/);
  assert.doesNotMatch(createGroupHelp, /create-programme|--deliverable/);

  const queryHelp = cliHelp("query-cards", "--help");
  assert.match(queryHelp, /--group/);
  assert.doesNotMatch(queryHelp, /--programme/);
});
