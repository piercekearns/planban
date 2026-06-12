import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PLANBAN_MARKETPLACE_NAME = "planban";
const PLANBAN_PUBLIC_SOURCE_PATTERN = /(?:github\.com[:/])?piercekearns\/planban(?:\.git)?$/iu;
const GENERATED_SAFE_DIRTY_FILES = new Set([
  ".codex-marketplace-install.json",
  "package-lock.json",
  "plugins/planban/.mcp.json",
]);

export interface CommandCheck {
  command: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface MarketplacePreflight {
  name: "planban";
  root: string | null;
  sourceType: "git" | "local" | "unknown";
  source: string | null;
}

export interface GitPreflight {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  remote: string | null;
  head: string | null;
  dirtyFiles: string[];
  generatedSafeDirtyFiles: string[];
  blockingDirtyFiles: string[];
}

export interface PlanbanUpdatePreflight {
  checkedAt: string;
  runtimeRoot: string;
  codexHome: string;
  installShape: "git-marketplace" | "local-clone" | "local-dev" | "unknown";
  directUpdateAvailable: boolean;
  prerequisites: {
    node: CommandCheck;
    npm: CommandCheck;
    git: CommandCheck;
    codex: CommandCheck;
  };
  marketplace: MarketplacePreflight;
  git: GitPreflight;
  blockedReasons: string[];
  warnings: string[];
  recommendedAction: "update-now" | "update-with-codex" | "setup-prerequisites";
  setupPrompt: string | null;
  fallbackPrompt: string;
}

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<RunCommandResult>;

interface PreflightOptions {
  runtimeRoot: string;
  codexHome?: string;
  runCommand?: RunCommand;
  checkedAt?: string;
}

const defaultRunCommand: RunCommand = async (command, args, options) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 5000,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const commandError = error as Error & {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      signal?: unknown;
    };
    return {
      exitCode: typeof commandError.code === "number" ? commandError.code : 1,
      stdout: typeof commandError.stdout === "string" ? commandError.stdout : "",
      stderr: typeof commandError.stderr === "string" ? commandError.stderr : commandError.message,
    };
  }
};

function codexHomePath(codexHome?: string) {
  return resolve(codexHome || process.env.CODEX_HOME || `${homedir()}/.codex`);
}

function firstLine(value: string) {
  return value.trim().split(/\r?\n/u)[0]?.trim() || null;
}

async function commandCheck(command: string, args: string[], runCommand: RunCommand): Promise<CommandCheck> {
  const result = await runCommand(command, args, { timeoutMs: 5000 });
  const output = firstLine(result.stdout) ?? firstLine(result.stderr);
  return {
    command,
    available: result.exitCode === 0,
    version: result.exitCode === 0 ? output : null,
    error: result.exitCode === 0 ? null : output ?? `${command} was not available`,
  };
}

function parseTomlStringValue(section: string, key: string) {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "imu"));
  return match?.[1] ?? null;
}

async function readMarketplaceConfig(codexHome: string): Promise<Pick<MarketplacePreflight, "sourceType" | "source">> {
  const configPath = resolve(codexHome, "config.toml");
  const config = await readFile(configPath, "utf8").catch(() => "");
  const sectionMatch = config.match(/\[marketplaces\.planban\]\s*([\s\S]*?)(?=\n\[|$)/u);
  if (!sectionMatch) return { sourceType: "unknown", source: null };

  const section = sectionMatch[1] ?? "";
  const sourceType = parseTomlStringValue(section, "source_type");
  const source = parseTomlStringValue(section, "source");

  return {
    sourceType: sourceType === "git" || sourceType === "local" ? sourceType : "unknown",
    source,
  };
}

function parseMarketplaceRoot(output: string) {
  const lines = output.split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith(`${PLANBAN_MARKETPLACE_NAME} `)) continue;
    const parts = trimmed.split(/\s+/u);
    return parts[1] ? resolve(parts[1]) : null;
  }
  return null;
}

async function readMarketplace(codexHome: string, runCommand: RunCommand): Promise<MarketplacePreflight> {
  const config = await readMarketplaceConfig(codexHome);
  const list = await runCommand("codex", ["plugin", "marketplace", "list"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    timeoutMs: 5000,
  });

  return {
    name: PLANBAN_MARKETPLACE_NAME,
    root: list.exitCode === 0 ? parseMarketplaceRoot(list.stdout) : null,
    sourceType: config.sourceType,
    source: config.source,
  };
}

async function gitValue(runCommand: RunCommand, runtimeRoot: string, args: string[]) {
  const result = await runCommand("git", ["-C", runtimeRoot, ...args], { timeoutMs: 5000 });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function parseGitStatus(output: string) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const path = line.replace(/^.. ?/u, "").trim();
      const renameTarget = path.split(" -> ").at(-1);
      return renameTarget ?? path;
    });
}

function classifyDirtyFiles(dirtyFiles: string[]) {
  const generatedSafeDirtyFiles = dirtyFiles.filter((file) => GENERATED_SAFE_DIRTY_FILES.has(file));
  const blockingDirtyFiles = dirtyFiles.filter((file) => !GENERATED_SAFE_DIRTY_FILES.has(file));
  return { generatedSafeDirtyFiles, blockingDirtyFiles };
}

async function readGit(runtimeRoot: string, runCommand: RunCommand): Promise<GitPreflight> {
  const root = await gitValue(runCommand, runtimeRoot, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    return {
      isRepo: false,
      root: null,
      branch: null,
      remote: null,
      head: null,
      dirtyFiles: [],
      generatedSafeDirtyFiles: [],
      blockingDirtyFiles: [],
    };
  }

  const [branch, remote, head, status] = await Promise.all([
    gitValue(runCommand, runtimeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitValue(runCommand, runtimeRoot, ["config", "--get", "remote.origin.url"]),
    gitValue(runCommand, runtimeRoot, ["rev-parse", "HEAD"]),
    gitValue(runCommand, runtimeRoot, ["status", "--porcelain"]),
  ]);
  const dirtyFiles = parseGitStatus(status ?? "");
  const classified = classifyDirtyFiles(dirtyFiles);

  return {
    isRepo: true,
    root: resolve(root),
    branch,
    remote,
    head,
    dirtyFiles,
    generatedSafeDirtyFiles: classified.generatedSafeDirtyFiles,
    blockingDirtyFiles: classified.blockingDirtyFiles,
  };
}

function isSamePath(left: string | null, right: string | null) {
  return Boolean(left && right && resolve(left) === resolve(right));
}

function isPublicPlanbanSource(source: string | null) {
  return Boolean(source && PLANBAN_PUBLIC_SOURCE_PATTERN.test(source.replace(/^https?:\/\//iu, "")));
}

function installShape(runtimeRoot: string, marketplace: MarketplacePreflight, git: GitPreflight) {
  if (
    marketplace.sourceType === "git" &&
    isPublicPlanbanSource(marketplace.source) &&
    (isSamePath(marketplace.root, runtimeRoot) || isSamePath(marketplace.root, git.root))
  ) {
    return "git-marketplace" as const;
  }

  if (
    marketplace.sourceType === "local" &&
    (isSamePath(marketplace.root, runtimeRoot) || isSamePath(marketplace.root, git.root))
  ) {
    return "local-clone" as const;
  }

  if (git.isRepo && isPublicPlanbanSource(git.remote)) return "local-dev" as const;
  return "unknown" as const;
}

function missingPrerequisites(prerequisites: PlanbanUpdatePreflight["prerequisites"]) {
  return Object.values(prerequisites)
    .filter((check) => !check.available)
    .map((check) => check.command);
}

function buildSetupPrompt(missing: string[]) {
  if (missing.length === 0) return null;
  return [
    "Help me finish setting up Planban prerequisites.",
    "",
    `Missing command${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    "",
    "Planban runs locally and needs Node.js, npm, git, and the Codex CLI/plugin tools.",
    "If Node.js or npm is missing, explain that Node.js LTS normally includes npm. Ask me before installing anything.",
    "Use the safest install method for this machine, then verify node --version, npm --version, git --version, and codex --version.",
    "After prerequisites are available, return to the Planban install or update flow.",
  ].join("\n");
}

function buildFallbackPrompt(install: string, marketplace: MarketplacePreflight) {
  return [
    "Use the Planban plugin or skill if it is available.",
    "I want to update my local Planban install safely.",
    "",
    `Detected install shape: ${install}`,
    `Detected marketplace source: ${marketplace.source ?? "(unknown)"}`,
    "",
    "Before changing anything, inspect how Planban is installed on this machine.",
    "If it is a Git-backed marketplace install, run codex plugin marketplace upgrade planban, then reinstall/refresh planban@planban.",
    "If it is a local clone install, update the clone first, then reinstall/refresh planban@planban.",
    "Before any storage migration, create a timestamped backup of the affected ~/.planban state and explain how to restore it.",
    "Do not upload or expose private board contents, repo paths, logs, or local project details.",
    "After updating, verify the running Planban version, plugin version, MCP tools, and board load.",
  ].join("\n");
}

async function fileExists(path: string) {
  return access(path).then(() => true, () => false);
}

export async function updatePreflight(options: PreflightOptions): Promise<PlanbanUpdatePreflight> {
  const runtimeRoot = resolve(options.runtimeRoot);
  const codexHome = codexHomePath(options.codexHome);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const checkedAt = options.checkedAt ?? new Date().toISOString();

  const [node, npm, gitCommand, codex] = await Promise.all([
    commandCheck("node", ["--version"], runCommand),
    commandCheck("npm", ["--version"], runCommand),
    commandCheck("git", ["--version"], runCommand),
    commandCheck("codex", ["--version"], runCommand),
  ]);

  const prerequisites = { node, npm, git: gitCommand, codex };
  const [marketplace, git] = await Promise.all([
    readMarketplace(codexHome, runCommand),
    readGit(runtimeRoot, runCommand),
  ]);
  const shape = installShape(runtimeRoot, marketplace, git);
  const missing = missingPrerequisites(prerequisites);
  const blockedReasons: string[] = [];
  const warnings: string[] = [];

  if (missing.length > 0) {
    blockedReasons.push(`Missing required command${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }

  if (shape === "unknown") {
    blockedReasons.push("Planban could not identify this install as a supported Git-backed marketplace or local clone install.");
  }

  if (shape === "local-dev") {
    blockedReasons.push("This looks like a development checkout, so direct self-update is disabled.");
  }

  if (git.blockingDirtyFiles.length > 0) {
    blockedReasons.push(
      `Git has ${git.blockingDirtyFiles.length} local change${git.blockingDirtyFiles.length === 1 ? "" : "s"} outside generated install files.`,
    );
  }

  if (git.generatedSafeDirtyFiles.length > 0) {
    warnings.push(`Generated install files have local changes and may be refreshed during update: ${git.generatedSafeDirtyFiles.join(", ")}`);
  }

  if (shape === "git-marketplace" && marketplace.root && !await fileExists(marketplace.root)) {
    blockedReasons.push("The Planban marketplace root is registered but no longer exists on disk.");
  }

  const directUpdateAvailable = blockedReasons.length === 0 && (shape === "git-marketplace" || shape === "local-clone");
  const recommendedAction = missing.length > 0
    ? "setup-prerequisites"
    : directUpdateAvailable
      ? "update-now"
      : "update-with-codex";

  return {
    checkedAt,
    runtimeRoot,
    codexHome,
    installShape: shape,
    directUpdateAvailable,
    prerequisites,
    marketplace,
    git,
    blockedReasons,
    warnings,
    recommendedAction,
    setupPrompt: buildSetupPrompt(missing),
    fallbackPrompt: buildFallbackPrompt(shape, marketplace),
  };
}
