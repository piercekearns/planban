import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { updatePreflight, type RunCommand } from "../src/core/updatePreflight";

const tempRoot = "/tmp/planban-update-preflight-test";

function successful(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string) {
  return { exitCode: 1, stdout: "", stderr };
}

function commandKey(command: string, args: string[]) {
  if (command === "git" && args[0] === "-C") return `${command} ${args.slice(2).join(" ")}`;
  return `${command} ${args.join(" ")}`;
}

function fakeRunCommand(overrides: Record<string, ReturnType<typeof successful> | ReturnType<typeof failed>> = {}): RunCommand {
  const defaults: Record<string, ReturnType<typeof successful> | ReturnType<typeof failed>> = {
    "node --version": successful("v24.0.0\n"),
    "npm --version": successful("11.0.0\n"),
    "git --version": successful("git version 2.51.0\n"),
    "codex --version": successful("codex 0.68.0\n"),
  };

  return async (command, args) => {
    const key = commandKey(command, args);
    return overrides[key] ?? defaults[key] ?? failed(`No fake command for ${key}`);
  };
}

test.afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("allows direct update for a clean Git-backed Planban marketplace install", async () => {
  const codexHome = join(tempRoot, "codex-home");
  const marketplaceRoot = join(codexHome, ".tmp", "marketplaces", "planban");
  await mkdir(marketplaceRoot, { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    [
      "[marketplaces.planban]",
      'source_type = "git"',
      'source = "https://github.com/piercekearns/planban.git"',
      "",
    ].join("\n"),
    "utf8",
  );

  const preflight = await updatePreflight({
    runtimeRoot: marketplaceRoot,
    codexHome,
    checkedAt: "2026-06-12T00:00:00.000Z",
    runCommand: fakeRunCommand({
      "codex plugin marketplace list": successful(`planban ${marketplaceRoot}\n`),
      "git rev-parse --show-toplevel": successful(`${marketplaceRoot}\n`),
      "git symbolic-ref --quiet --short HEAD": successful("main\n"),
      "git config --get remote.origin.url": successful("https://github.com/piercekearns/planban.git\n"),
      "git rev-parse HEAD": successful("abc123\n"),
      "git status --porcelain": successful(" M plugins/planban/.mcp.json\n?? .codex-marketplace-install.json\n"),
    }),
  });

  assert.equal(preflight.installShape, "git-marketplace");
  assert.equal(preflight.directUpdateAvailable, true);
  assert.equal(preflight.recommendedAction, "update-now");
  assert.deepEqual(preflight.blockedReasons, []);
  assert.deepEqual(preflight.git.generatedSafeDirtyFiles.sort(), [
    ".codex-marketplace-install.json",
    "plugins/planban/.mcp.json",
  ]);
});

test("falls back to setup prompt when required local commands are missing", async () => {
  const codexHome = join(tempRoot, "codex-home");
  const marketplaceRoot = join(codexHome, ".tmp", "marketplaces", "planban");
  await mkdir(marketplaceRoot, { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    [
      "[marketplaces.planban]",
      'source_type = "git"',
      'source = "https://github.com/piercekearns/planban.git"',
      "",
    ].join("\n"),
    "utf8",
  );

  const preflight = await updatePreflight({
    runtimeRoot: marketplaceRoot,
    codexHome,
    checkedAt: "2026-06-12T00:00:00.000Z",
    runCommand: fakeRunCommand({
      "npm --version": failed("npm: command not found"),
      "codex plugin marketplace list": successful(`planban ${marketplaceRoot}\n`),
      "git rev-parse --show-toplevel": successful(`${marketplaceRoot}\n`),
      "git symbolic-ref --quiet --short HEAD": successful("main\n"),
      "git config --get remote.origin.url": successful("https://github.com/piercekearns/planban.git\n"),
      "git rev-parse HEAD": successful("abc123\n"),
      "git status --porcelain": successful(""),
    }),
  });

  assert.equal(preflight.directUpdateAvailable, false);
  assert.equal(preflight.recommendedAction, "setup-prerequisites");
  assert.match(preflight.blockedReasons.join("\n"), /npm/u);
  assert.match(preflight.setupPrompt ?? "", /Node\.js LTS normally includes npm/u);
});
