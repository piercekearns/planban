import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { platformInvocation } from "../scripts/platform-invocation.mjs";

test("runs npm-installed Windows command shims through cmd.exe", () => {
  assert.deepEqual(
    platformInvocation("codex", ["plugin", "marketplace", "upgrade", "planban"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "codex", "plugin", "marketplace", "upgrade", "planban"],
    },
  );
  assert.deepEqual(
    platformInvocation("npm.cmd", ["install"], { platform: "win32", comspec: "cmd.exe" }),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", "install"] },
  );
});

test("does not route native Windows or non-Windows commands through a shell", () => {
  assert.deepEqual(
    platformInvocation("git", ["rev-parse", "HEAD"], { platform: "win32", comspec: "cmd.exe" }),
    { command: "git", args: ["rev-parse", "HEAD"] },
  );
  assert.deepEqual(
    platformInvocation("codex", ["--version"], { platform: "linux" }),
    { command: "codex", args: ["--version"] },
  );
});

test("the installed-runtime verifier uses the shared Windows shim boundary", async () => {
  const source = await readFile(new URL("../scripts/verify-local-install.mjs", import.meta.url), "utf8");
  assert.match(source, /platformInvocation\("codex", \["plugin", "list"\]\)/u);
  assert.doesNotMatch(source, /execFileAsync\("codex"/u);
});
