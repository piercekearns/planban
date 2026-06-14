#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.argv[2] ?? join(repoRoot, "tmp", "planban-public-release"));

const copyPaths = [
  "bin",
  "dist",
  "plugins",
  "release",
  "scripts/configure-local-plugin.mjs",
  "scripts/prepare-local-update.mjs",
  "scripts/restart-planban-after-update.mjs",
  "scripts/smoke.ts",
  "scripts/update-local-install.mjs",
  "scripts/verify-local-install.mjs",
  "scripts/verify-planban-mcp.mjs",
  "src",
  "tests",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
];

const publicGitignore = `node_modules/
.DS_Store
.env
.env.*
.planban/
.planban-update-runs/
tmp/
coverage/
dist/site/
*.log
`;

const marketplace = {
  name: "planban",
  interface: {
    displayName: "Planban",
  },
  plugins: [
    {
      name: "planban",
      source: {
        source: "local",
        path: "./plugins/planban",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    },
  ],
};

const placeholderMcp = {
  mcpServers: {
    planban: {
      cwd: "__PLANBAN_REPO_ROOT__",
      command: "node",
      args: ["--import", "tsx/esm", "./plugins/planban/mcp/server.mjs"],
      env: {
        PLANBAN_REPO_ROOT: "__PLANBAN_REPO_ROOT__",
      },
    },
  },
};

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function copyPath(relPath) {
  await mkdir(dirname(join(outputRoot, relPath)), { recursive: true });
  await cp(join(repoRoot, relPath), join(outputRoot, relPath), {
    recursive: true,
    force: true,
    filter(source) {
      const rel = source.slice(repoRoot.length + 1);
      if (rel === "src/site" || rel.startsWith("src/site/")) return false;
      if (rel === "dist/site" || rel.startsWith("dist/site/")) return false;
      return ![
        ".git",
        ".planban",
        "node_modules",
        "tmp",
      ].some((segment) => rel.split(/[\\/]/u).includes(segment));
    },
  });
}

const build = spawnSync("npm", ["run", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) {
  process.exitCode = build.status ?? 1;
  process.exit();
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const relPath of copyPaths) {
  await copyPath(relPath);
}

const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const releaseManifest = JSON.parse(await readFile(join(repoRoot, "release/latest.json"), "utf8"));
packageJson.license = "SEE LICENSE IN LICENSE.md";
packageJson.private = true;
packageJson.scripts = {
  dev: packageJson.scripts.dev,
  planban: packageJson.scripts.planban,
  typecheck: packageJson.scripts.typecheck,
  test: packageJson.scripts.test,
  build: packageJson.scripts.build,
  preview: packageJson.scripts.preview,
  smoke: packageJson.scripts.smoke,
  "plugin:configure": "node scripts/configure-local-plugin.mjs",
  "planban:demo": "node --import tsx/esm src/cli.ts demo",
};

await writeJson(join(outputRoot, "package.json"), packageJson);
const pluginManifestPath = join(outputRoot, "plugins/planban/.codex-plugin/plugin.json");
const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
pluginManifest.version = releaseManifest.pluginVersion ?? packageJson.version;
await writeJson(pluginManifestPath, pluginManifest);
await writeFile(join(outputRoot, "README.md"), await readFile(join(repoRoot, "docs/public-release/README.md"), "utf8"));
await writeFile(join(outputRoot, "LICENSE.md"), await readFile(join(repoRoot, "docs/public-release/LICENSE.md"), "utf8"));
await writeFile(join(outputRoot, ".gitignore"), publicGitignore);
await cp(join(repoRoot, "docs/public-release/.github"), join(outputRoot, ".github"), {
  recursive: true,
  force: true,
});
await writeJson(join(outputRoot, ".agents/plugins/marketplace.json"), marketplace);
await writeJson(join(outputRoot, "plugins/planban/.mcp.json"), placeholderMcp);

const audit = spawnSync(process.execPath, [join(repoRoot, "scripts/audit-public-release.mjs"), outputRoot], {
  encoding: "utf8",
});
if (audit.status !== 0) {
  process.stderr.write(audit.stderr || audit.stdout);
  process.exitCode = audit.status ?? 1;
} else {
  process.stdout.write(JSON.stringify({ ok: true, outputRoot }, null, 2) + "\n");
}
