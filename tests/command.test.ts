import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { commandFor, planbanCommand, shellQuote } from "../src/core/command";

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

test("on Windows a path a shell would expand gets a description, never a wrong command", () => {
  assert.equal(commandFor("C:\\Tools\\Planban\\bin\\planban.mjs", { windows: true, onPath: false }), 'node "C:\\Tools\\Planban\\bin\\planban.mjs"');
  for (const path of ["C:\\Tools\\%USERNAME%\\bin\\planban.mjs", "C:\\$env\\bin\\planban.mjs", "C:\\a`b\\bin\\planban.mjs", "C:\\Hi!\\bin\\planban.mjs", "C:\\Tools\\\u201cPlanban\u201d\\bin\\planban.mjs", "C:\\a\u201eb\\bin\\planban.mjs", "C:\\a&b\\bin\\planban.mjs", "C:\\a'b\\bin\\planban.mjs"]) {
    assert.equal(commandFor(path, { windows: true, onPath: false }), 'node "<Planban install folder>\\bin\\planban.mjs"', path);
  }
  assert.equal(commandFor("C:\\Program Files (x86)\\Planban-2.0\\bin\\planban.mjs", { windows: true, onPath: false }), 'node "C:\\Program Files (x86)\\Planban-2.0\\bin\\planban.mjs"');
  assert.equal(commandFor("/anything", { windows: false, onPath: true }), "planban");
});
