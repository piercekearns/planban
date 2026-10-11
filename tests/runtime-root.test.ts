import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexMarketplaceConfig, resolvePlanbanRuntime } from "../plugins/planban/scripts/runtime-root.mjs";

async function runtime(root: string) {
  for (const file of ["bin/planban.mjs", "src/cli.ts", "src/core/storage.ts"]) {
    const path = join(root, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "planban" }));
  return root;
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
    const env = { CODEX_HOME: home };
    assert.throws(() => resolvePlanbanRuntime(cache, env), /runtime not found/u);
    await runtime(marketplace);
    assert.equal(resolvePlanbanRuntime(cache, env), marketplace);
    assert.throws(() => resolvePlanbanRuntime(join(root, "unrelated/plugin"), env), /runtime not found/u);
    assert.throws(() => resolvePlanbanRuntime(cache, { ...env, PLANBAN_REPO_ROOT: join(root, "missing") }), /PLANBAN_REPO_ROOT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex local-folder marketplaces resolve through config.toml after the Git marketplace clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-runtime-"));
  try {
    const home = join(root, "custom codex home");
    const cache = join(home, "plugins/cache/planban/planban/1.1.6");
    await mkdir(cache, { recursive: true });
    const env = { CODEX_HOME: home };
    const folder = await runtime(join(root, "release folder"));
    const config = (sourceType: string, source: string) => writeFile(
      join(home, "config.toml"),
      `model = "x"\n\n[marketplaces.planban]\nsource_type = "${sourceType}"\nsource = ${source}\n\n[marketplaces.paper]\nsource_type = "local"\nsource = "${join(root, "elsewhere")}"\n`,
    );

    // Missing config, then a config that does not name a complete runtime, keep the existing error.
    assert.throws(() => resolvePlanbanRuntime(cache, env), /runtime not found/u);
    await writeFile(join(home, "config.toml"), "[marketplaces.planban\nsource_type = \"local\"\n");
    assert.throws(() => resolvePlanbanRuntime(cache, env), /runtime not found/u);
    await config("local", JSON.stringify(join(root, "missing")));
    assert.throws(() => resolvePlanbanRuntime(cache, env), /runtime not found/u);
    await config("git", JSON.stringify(folder));
    assert.throws(() => resolvePlanbanRuntime(cache, env), /runtime not found/u);

    await config("local", JSON.stringify(folder));
    assert.equal(resolvePlanbanRuntime(cache, env), folder);
    await config("local", `'${folder}'  # literal string`);
    assert.equal(resolvePlanbanRuntime(cache, env), folder);
    await config("local", JSON.stringify("../release folder"));
    assert.equal(resolvePlanbanRuntime(cache, env), folder);

    // CODEX_HOME is respected: the same layout under another home is not consulted.
    assert.throws(() => resolvePlanbanRuntime(cache, { CODEX_HOME: join(root, "other") }), /runtime not found/u);

    // A Git marketplace clone still takes precedence.
    const clone = await runtime(join(home, ".tmp/marketplaces/planban"));
    assert.equal(resolvePlanbanRuntime(cache, env), clone);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex marketplace config extraction reads only the named table's string keys", () => {
  const text = [
    "[marketplaces.paper]",
    'source = "/paper"',
    "[ marketplaces . \"planban\" ]  # comment",
    'source_type = "local"\r',
    'source = "C:\\\\Planban \\"1.1.6\\""',
    "last_updated = 2026-10-11",
    "[[profiles]]",
    'source = "/not-this"',
  ].join("\n");
  assert.deepEqual(codexMarketplaceConfig(text, "planban"), { source_type: "local", source: 'C:\\Planban "1.1.6"' });
  assert.equal(codexMarketplaceConfig(text, "missing"), null);
  assert.equal(codexMarketplaceConfig("", "planban"), null);
});

test("Codex local marketplace sources expand a leading ~", async () => {
  const root = await mkdtemp(join(homedir(), ".planban-runtime-test-"));
  try {
    const home = join(root, "codex");
    const cache = join(home, "plugins/cache/planban/planban/1.1.6");
    await mkdir(cache, { recursive: true });
    const folder = await runtime(join(root, "release"));
    await writeFile(join(home, "config.toml"), `[marketplaces.planban]\nsource_type = "local"\nsource = "~/${folder.slice(homedir().length + 1)}"\n`);
    assert.equal(resolvePlanbanRuntime(cache, { CODEX_HOME: home }), folder);
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
