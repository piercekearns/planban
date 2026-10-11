import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePlanbanRuntime } from "../plugins/planban/scripts/runtime-root.mjs";

async function runtime(root: string) {
  for (const file of ["bin/planban.mjs", "src/cli.ts", "src/core/storage.ts"]) {
    const path = join(root, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "planban" }));
  return root;
}

// An environment whose PATH holds only `bin`, so tests never reach a real Codex.
function codexEnv(bin: string, codexHome: string) {
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(path|planban_repo_root|codex_home)$/iu.test(key)),
  );
  return { ...env, PATH: bin, CODEX_HOME: codexHome };
}

type FakeCodexBehaviour = { stdout?: string; stderr?: string; status?: number; sleepMs?: number };

// A fake `codex` executable that records how it was called and then behaves as told.
async function fakeCodex(bin: string, behaviour: FakeCodexBehaviour) {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "behaviour.json"), JSON.stringify(behaviour));
  await writeFile(join(bin, "codex.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
writeFileSync(new URL("call.json", here), JSON.stringify({ args: process.argv.slice(2), codexHome: process.env.CODEX_HOME }));
const behaviour = JSON.parse(readFileSync(new URL("behaviour.json", here), "utf8"));
if (behaviour.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, behaviour.sleepMs);
process.stdout.write(behaviour.stdout ?? "");
process.stderr.write(behaviour.stderr ?? "");
process.exitCode = behaviour.status ?? 0;
`);
  if (process.platform === "win32") {
    await writeFile(join(bin, "codex.cmd"), `@"${process.execPath}" "%~dp0codex.mjs" %*\r\n`);
  } else {
    await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "\${0%/*}/codex.mjs" "$@"\n`);
    await chmod(join(bin, "codex"), 0o755);
  }
  return {
    call: async () => existsSync(join(bin, "call.json")) ? JSON.parse(await readFile(join(bin, "call.json"), "utf8")) : null,
    listing: (root: unknown) => JSON.stringify({
      marketplaces: [
        { name: "paper", root: "/elsewhere", marketplaceSource: { sourceType: "git", source: "https://example.com/paper.git" } },
        { name: "planban", root, marketplaceSource: { sourceType: "local", source: root } },
      ],
    }),
  };
}

test("source checkout wins over marketplace, while configured and bundled runtimes retain precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-runtime-"));
  try {
    const local = await runtime(join(root, "local checkout"));
    const plugin = join(local, "plugins/planban");
    await mkdir(plugin, { recursive: true });
    const home = join(root, "codex");
    await runtime(join(home, ".tmp/marketplaces/planban"));
    const env = { CODEX_HOME: home };
    assert.equal(resolvePlanbanRuntime(plugin, env), local);
    assert.equal(resolvePlanbanRuntime(plugin, { ...env, PLANBAN_REPO_ROOT: "__PLANBAN_REPO_ROOT__" }), local);
    const explicit = await runtime(join(root, "explicit"));
    assert.equal(resolvePlanbanRuntime(plugin, { ...env, PLANBAN_REPO_ROOT: explicit }), explicit);
    await writeFile(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { planban: { cwd: explicit } } }));
    assert.equal(resolvePlanbanRuntime(plugin, env), explicit);
    const bundled = await runtime(join(plugin, "runtime"));
    assert.equal(resolvePlanbanRuntime(plugin, env), bundled);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marketplace recovery requires an installed cache and a complete runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-runtime-"));
  try {
    const home = join(root, "codex");
    const cache = join(home, "plugins/cache/planban/planban/1.1.5");
    await mkdir(cache, { recursive: true });
    const marketplace = join(home, ".tmp/marketplaces/planban");
    await mkdir(join(marketplace, "bin"), { recursive: true });
    await writeFile(join(marketplace, "bin/planban.mjs"), "");
    const env = codexEnv(join(root, "empty bin"), home);
    assert.throws(() => resolvePlanbanRuntime(cache, env), /runtime not found/u);
    await runtime(marketplace);
    assert.equal(resolvePlanbanRuntime(cache, env), marketplace);
    assert.throws(() => resolvePlanbanRuntime(join(root, "unrelated/plugin"), env), /runtime not found/u);
    assert.throws(() => resolvePlanbanRuntime(cache, { ...env, PLANBAN_REPO_ROOT: join(root, "missing") }), /PLANBAN_REPO_ROOT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex local-folder marketplaces resolve through Codex's own marketplace list", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-runtime-"));
  try {
    const home = join(root, "custom codex home");
    const cache = join(home, "plugins/cache/planban/planban/1.1.6");
    await mkdir(cache, { recursive: true });
    const bin = join(root, "bin");
    const env = codexEnv(bin, home);
    const folder = await runtime(join(root, "release folder"));
    const codex = await fakeCodex(bin, {});
    await writeFile(join(bin, "behaviour.json"), JSON.stringify({ stdout: codex.listing(folder) }));

    assert.equal(resolvePlanbanRuntime(cache, env), folder);
    assert.deepEqual(await codex.call(), { args: ["plugin", "marketplace", "list", "--json"], codexHome: home });

    // A Git marketplace clone still wins, without asking Codex.
    await rm(join(bin, "call.json"));
    const clone = await runtime(join(home, ".tmp/marketplaces/planban"));
    assert.equal(resolvePlanbanRuntime(cache, env), clone);
    assert.equal(await codex.call(), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex marketplace lookups that fail keep the existing error, with a reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-runtime-"));
  try {
    const home = join(root, "codex");
    const cache = join(home, "plugins/cache/planban/planban/1.1.6");
    await mkdir(cache, { recursive: true });
    const bin = join(root, "bin");
    const env = codexEnv(bin, home);
    const notFound = (reason: RegExp) => new RegExp(`runtime not found \\(.*${reason.source}.*\\)`, "u");

    assert.throws(() => resolvePlanbanRuntime(cache, env), process.platform === "win32" ? /runtime not found \(/u : notFound(/not found on PATH/u));

    const codex = await fakeCodex(bin, {});
    const cases: Array<[FakeCodexBehaviour, RegExp]> = [
      [{ status: 2, stdout: codex.listing(await runtime(join(root, "unused"))) }, /exited with 2/u],
      [{ status: 1, stderr: "Error: failed to load marketplace(s):\n- `paper`: broken\n" }, /exited with 1: Error: failed to load marketplace\(s\): - `paper`: broken/u],
      [{ stdout: "not json" }, /invalid JSON/u],
      [{ stdout: JSON.stringify({ marketplaces: [] }) }, /no planban marketplace/u],
      [{ stdout: codex.listing("relative/release") }, /not an absolute path/u],
      [{ stdout: codex.listing(join(root, "missing")) }, /no complete Planban runtime/u],
      [{ stdout: codex.listing(await runtime(join(root, "late"))), sleepMs: 3000 }, /timed out/u],
    ];
    for (const [behaviour, reason] of cases) {
      await writeFile(join(bin, "behaviour.json"), JSON.stringify(behaviour));
      assert.throws(() => resolvePlanbanRuntime(cache, env, { codexTimeoutMs: 500 }), notFound(reason));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude Code installs resolve the marketplace runtime through the known-marketplaces registry or the conventional clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-runtime-"));
  try {
    const home = join(root, "claude");
    const cache = join(home, "plugins/cache/planban/planban/1.1.5");
    await mkdir(cache, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(root, "codex") };
    assert.throws(() => resolvePlanbanRuntime(cache, env), /runtime not found/u);

    const clone = await runtime(join(home, "plugins/marketplaces/planban"));
    assert.equal(resolvePlanbanRuntime(cache, env), clone);

    const directorySource = await runtime(join(root, "source checkout"));
    await mkdir(join(home, "plugins"), { recursive: true });
    await writeFile(
      join(home, "plugins/known_marketplaces.json"),
      JSON.stringify({ planban: { source: { source: "directory", path: directorySource }, installLocation: directorySource } }),
    );
    assert.equal(resolvePlanbanRuntime(cache, env), directorySource);

    const otherMarketplace = join(home, "plugins/cache/other/planban/1.1.5");
    await mkdir(otherMarketplace, { recursive: true });
    assert.throws(() => resolvePlanbanRuntime(otherMarketplace, env), /runtime not found/u);
    await writeFile(
      join(home, "plugins/known_marketplaces.json"),
      JSON.stringify({ other: { source: { source: "github", repo: "x/y" }, installLocation: join(home, "plugins/marketplaces/other") } }),
    );
    await runtime(join(home, "plugins/marketplaces/other"));
    assert.equal(resolvePlanbanRuntime(otherMarketplace, env), join(home, "plugins/marketplaces/other"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unexpanded host template variables in .mcp.json are ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-runtime-"));
  try {
    const local = await runtime(join(root, "checkout"));
    const plugin = join(local, "plugins/planban");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { planban: { cwd: "${CLAUDE_PLUGIN_ROOT}", env: { PLANBAN_REPO_ROOT: "${CLAUDE_PLUGIN_ROOT}/runtime" } } } }));
    assert.equal(resolvePlanbanRuntime(plugin, { CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude") }), local);
  } finally { await rm(root, { recursive: true, force: true }); }
});
