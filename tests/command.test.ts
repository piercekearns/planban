import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { planbanCommand, shellQuote } from "../src/core/command";

test("messages name a Planban command that runs on this computer", () => {
  const command = planbanCommand();
  if (command === "planban") return;
  // Not installed as a command: the installed script, quoted, which exists.
  const match = /^node (['"])(.+\/bin\/planban\.mjs)\1$/.exec(command);
  assert.ok(match, command);
  assert.ok(existsSync(match[2]!));
});

test("an install folder's name can't change or break the printed command", { skip: process.platform === "win32" }, () => {
  for (const folder of ["/tmp/Planban $(echo EXPANDED)/bin/planban.mjs", "/tmp/it's \"here\"/bin/planban.mjs", "/tmp/a`b`\\c/bin/planban.mjs"]) {
    const echoed = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(folder, false)}`], { encoding: "utf8" });
    assert.equal(echoed, folder);
  }
  assert.equal(shellQuote("C:\\Program Files\\Planban\\bin\\planban.mjs", true), "\"C:\\Program Files\\Planban\\bin\\planban.mjs\"");
});

test("the command helper, which the board page also bundles, imports nothing Node-only", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["src/core/command.ts", "src/core/staleness.ts"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^import [^\n]*from "node:/mu, `${file} must stay loadable in a browser`);
  }
});
