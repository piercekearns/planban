import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
