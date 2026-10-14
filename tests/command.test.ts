import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { planbanCommand } from "../src/core/command";

test("messages name a Planban command that runs on this computer", () => {
  const command = planbanCommand();
  if (command === "planban") return;
  // Not installed as a command: the installed script, quoted, which exists.
  const match = /^node "(.+\/bin\/planban\.mjs)"$/.exec(command);
  assert.ok(match, command);
  assert.ok(existsSync(match[1]!));
});
