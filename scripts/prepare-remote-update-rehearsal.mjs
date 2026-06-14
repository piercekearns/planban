#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  const options = {
    remoteUrl: "https://github.com/piercekearns/planban-update-rehearsal.git",
    oldVersion: "0.1.12",
    newVersion: "0.1.13",
    port: 4329,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote-url") {
      options.remoteUrl = argv[++index] ?? options.remoteUrl;
    } else if (arg === "--old-version") {
      options.oldVersion = argv[++index] ?? options.oldVersion;
    } else if (arg === "--new-version") {
      options.newVersion = argv[++index] ?? options.newVersion;
    } else if (arg === "--port") {
      options.port = Number(argv[++index] ?? options.port);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error("--port must be a positive integer");
  return options;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(stderr || `${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function patchVersion(root, version, latestVersion, options) {
  const packagePath = join(root, "package.json");
  const packageJson = await readJson(packagePath);
  packageJson.version = version;
  await writeJson(packagePath, packageJson);

  const packageLockPath = join(root, "package-lock.json");
  const packageLock = await readJson(packageLockPath);
  packageLock.version = version;
  if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
  await writeJson(packageLockPath, packageLock);

  const releasePath = join(root, "release/latest.json");
  const release = await readJson(releasePath);
  release.version = latestVersion;
  release.pluginVersion = latestVersion;
  release.mcpVersion = latestVersion;
  release.storageSchemaVersion = 2;
  release.minimumStorageSchemaVersion = 2;
  release.sourceUrl = options.remoteUrl.replace(/\.git$/u, "");
  release.releaseNotesUrl = `${release.sourceUrl}/releases/tag/v${latestVersion}`;
  release.summary = "Private remote update rehearsal.";
  release.updatePrompt = "Update Planban through the private remote rehearsal fixture.";
  release.postUpdateRoute = "board-with-changelog";
  release.changelogTitle = "Private remote update rehearsal";
  release.changelogSummary =
    "This unpublished test proves the one-click updater can pull from GitHub, reinstall, restart, and reopen the board before a public release is created.";
  release.targetRef = "main";
  release.directUpdateSupportedFrom = options.oldVersion;
  delete release.targetCommit;
  await writeJson(releasePath, release);

  const pluginPath = join(root, "plugins/planban/.codex-plugin/plugin.json");
  const plugin = await readJson(pluginPath);
  plugin.version = version;
  await writeJson(pluginPath, plugin);

  const versionPath = join(root, "src/core/version.ts");
  let versionSource = await readFile(versionPath, "utf8");
  versionSource = versionSource
    .replace(/PLANBAN_VERSION = "[^"]+"/u, `PLANBAN_VERSION = "${version}"`)
    .replace(/PLANBAN_PLUGIN_VERSION = "[^"]+"/u, `PLANBAN_PLUGIN_VERSION = "${version}"`)
    .replace(/PLANBAN_MCP_VERSION = "[^"]+"/u, `PLANBAN_MCP_VERSION = "${version}"`);
  await writeFile(versionPath, versionSource, "utf8");

  const mcpServerPath = join(root, "plugins/planban/mcp/server.mjs");
  if (existsSync(mcpServerPath)) {
    const mcpServerSource = readFileSync(mcpServerPath, "utf8").replace(
      /const SERVER_VERSION = "([^"]+)";/u,
      "const SERVER_VERSION = PLANBAN_MCP_VERSION;",
    );
    await writeFile(mcpServerPath, mcpServerSource, "utf8");
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitForFile(path, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFile(path, "utf8");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForStatus(baseUrl, expectedVersion, timeoutMs = 45000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await fetchJson(`${baseUrl}/api/status`);
      if (!expectedVersion || status.version?.version === expectedVersion) return status;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ${baseUrl}/api/status`);
}

async function writeManifestServerScript(scriptPath) {
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const [, , manifestPath, portPath] = process.argv;
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(readFileSync(manifestPath, "utf8"));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  writeFileSync(portPath, String(address.port));
});
`,
    "utf8",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(tmpdir(), "planban-remote-update-"));
  const releaseRoot = join(tempRoot, "release-source");
  const originWork = join(tempRoot, "origin-work");
  const installRoot = join(tempRoot, "install-root");
  const codexHome = join(tempRoot, "codex-home");
  const planbanHome = join(tempRoot, "planban-home");
  const projectRoot = join(tempRoot, "project");
  const restartPidFile = join(tempRoot, "restart.pid");
  const manifestServerScript = join(tempRoot, "manifest-server.mjs");
  const manifestFile = join(tempRoot, "latest.json");
  const manifestPortFile = join(tempRoot, "manifest-port");
  const manifestLog = join(tempRoot, "manifest-server.log");
  const appLog = join(tempRoot, "app-server.log");

  await run("node", ["scripts/build-public-release.mjs", releaseRoot], { quiet: true });
  await cp(releaseRoot, originWork, { recursive: true });
  await patchVersion(originWork, options.oldVersion, options.oldVersion, options);
  await run("git", ["init", "-b", "main"], { cwd: originWork, quiet: true });
  await run("git", ["add", "."], { cwd: originWork, quiet: true });
  await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", `remote fixture ${options.oldVersion}`], {
    cwd: originWork,
    quiet: true,
  });
  await run("git", ["remote", "add", "origin", options.remoteUrl], { cwd: originWork, quiet: true });
  await run("git", ["push", "--force", "origin", "main"], { cwd: originWork, quiet: true });

  await run("git", ["clone", options.remoteUrl, installRoot], { quiet: true });

  await patchVersion(originWork, options.newVersion, options.newVersion, options);
  await writeFile(join(originWork, "REMOTE_UPDATE_REHEARSAL_MARKER.txt"), `updated to ${options.newVersion} from private GitHub remote\n`, "utf8");
  await run("git", ["add", "-A"], { cwd: originWork, quiet: true });
  await run("git", ["-c", "user.name=Planban Test", "-c", "user.email=planban@example.test", "commit", "-m", `remote fixture ${options.newVersion}`], {
    cwd: originWork,
    quiet: true,
  });
  await run("git", ["push", "origin", "main"], { cwd: originWork, quiet: true });

  await mkdir(codexHome, { recursive: true });
  await mkdir(planbanHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await run("npm", ["install"], { cwd: installRoot, quiet: true });
  await run("node", ["scripts/configure-local-plugin.mjs", installRoot], { cwd: installRoot, quiet: true });
  await run("codex", ["plugin", "marketplace", "add", installRoot], {
    cwd: installRoot,
    env: { CODEX_HOME: codexHome },
    quiet: true,
  });
  await run("codex", ["plugin", "add", "planban@planban"], {
    cwd: installRoot,
    env: { CODEX_HOME: codexHome },
    quiet: true,
  });
  await run("node", ["bin/planban.mjs", "init", "--cwd", projectRoot, "--title", "Remote Update Test", "--repo-id", "remote-update-test", "--no-agents"], {
    cwd: installRoot,
    env: { PLANBAN_HOME: planbanHome },
    quiet: true,
  });

  await writeFile(manifestFile, await readFile(join(originWork, "release/latest.json"), "utf8"), "utf8");
  await writeManifestServerScript(manifestServerScript);
  const manifestOut = openSync(manifestLog, "a");
  const manifestProcess = spawn(process.execPath, [manifestServerScript, manifestFile, manifestPortFile], {
    cwd: tempRoot,
    detached: true,
    stdio: ["ignore", manifestOut, manifestOut],
  });
  manifestProcess.unref();
  const manifestPort = (await waitForFile(manifestPortFile)).trim();

  const env = {
    CODEX_HOME: codexHome,
    PLANBAN_HOME: planbanHome,
    PLANBAN_UPDATE_MANIFEST_URL: `http://127.0.0.1:${manifestPort}/latest.json`,
    PLANBAN_RESTART_PID_FILE: restartPidFile,
  };
  const appOut = openSync(appLog, "a");
  const appProcess = spawn(process.execPath, ["bin/planban.mjs", "serve", "--cwd", projectRoot, "--port", String(options.port), "--no-vite"], {
    cwd: installRoot,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", appOut, appOut],
  });
  appProcess.unref();

  const baseUrl = `http://localhost:${options.port}`;
  const boardUrl = `${baseUrl}/boards/remote-update-test`;
  await waitForStatus(baseUrl, options.oldVersion);
  const updateStatus = await fetchJson(`${baseUrl}/api/update-status`);
  const preflight = await fetchJson(`${baseUrl}/api/update-preflight`);
  if (!updateStatus.updateAvailable || updateStatus.latest?.version !== options.newVersion) {
    throw new Error(`Expected update status to report ${options.newVersion}: ${JSON.stringify(updateStatus)}`);
  }
  if (!preflight.directUpdateAvailable) {
    throw new Error(`Expected direct update to be available: ${preflight.blockedReasons?.join("; ")}`);
  }

  const info = {
    ok: true,
    remoteUrl: options.remoteUrl,
    oldVersion: options.oldVersion,
    newVersion: options.newVersion,
    boardUrl,
    tempRoot,
    installRoot,
    codexHome,
    planbanHome,
    projectRoot,
    manifestUrl: env.PLANBAN_UPDATE_MANIFEST_URL,
    appPid: appProcess.pid,
    manifestPid: manifestProcess.pid,
    appLog,
    manifestLog,
    cleanupCommand: `kill ${appProcess.pid} ${manifestProcess.pid} 2>/dev/null || true; rm -rf ${tempRoot}`,
  };
  await writeJson(join(tempRoot, "remote-test-info.json"), info);
  process.stdout.write(JSON.stringify(info, null, 2) + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
