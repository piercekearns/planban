import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDemoBoard } from "./core/demo";
import { archiveBoard, deleteBoard, duplicateBoard, listAllBoards, restoreBoard } from "./core/registry";
import {
  getStatus,
  initializeProject,
  loadState,
  moveCard,
  readDoc,
  setCardStatus,
  writeDoc,
  createCard,
} from "./core/storage";
import { PLANBAN_STATUSES, type PlanbanStatus } from "./core/types";
import { buildUpdateCommandPlan, runPlanbanUpdate } from "./core/updateRunner";
import { updatePreflight } from "./core/updatePreflight";
import { PLANBAN_VERSION } from "./core/version";
import { startServer } from "./server/server";

function cwdOption(value: string | undefined) {
  return resolve(value ?? process.cwd());
}

function print(value: unknown, options: { output?: string }) {
  if (options.output === "json") {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  if (typeof value === "string") process.stdout.write(value + "\n");
  else process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function requireStatus(value: string): PlanbanStatus {
  if (!PLANBAN_STATUSES.includes(value as PlanbanStatus)) {
    throw new Error(`Invalid status "${value}". Expected one of: ${PLANBAN_STATUSES.join(", ")}`);
  }
  return value as PlanbanStatus;
}

function requireCreatePosition(value: string): "top" | "bottom" {
  if (value !== "top" && value !== "bottom") {
    throw new Error('Invalid position. Expected "top" or "bottom".');
  }
  return value;
}

function collectOption(value: string, previous: string[] = []) {
  return [...previous, value];
}

function parseMetadataJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--metadata-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  return new Promise((resolveRead, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveRead(data));
    process.stdin.on("error", reject);
  });
}

const program = new Command();
program.name("planban").description("Codex-native local planning board").version(PLANBAN_VERSION);

program
  .command("init")
  .option("--cwd <path>", "project directory")
  .option("--title <title>", "project title")
  .option("--repo-id <id>", "stable repo id")
  .option("--no-agents", "do not update AGENTS.md")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(
      await initializeProject({
        cwd: cwdOption(options.cwd),
        title: options.title,
        repoId: options.repoId,
        updateAgents: options.agents,
      }),
      options,
    );
  });

program
  .command("status")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await getStatus(cwdOption(options.cwd)), options);
  });

program
  .command("update")
  .description("inspect whether this local Planban install can update safely")
  .option("--dry-run", "inspect only; do not update files")
  .option("--execute", "run the direct local update when preflight allows it")
  .option("--runtime-root <path>", "Planban install/runtime root")
  .option("--current-board-url <url>", "board URL to reopen after update")
  .option("--target-version <version>", "target Planban version")
  .option("--target-ref <ref>", "target Git ref")
  .option("--target-commit <sha>", "target Git commit")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    if (options.execute && options.dryRun) {
      throw new Error("Use either --dry-run or --execute, not both.");
    }
    if (!options.execute) {
      const preflight = await updatePreflight({
        runtimeRoot: resolve(options.runtimeRoot ?? process.cwd()),
      });
      print({
        ...preflight,
        commandPlan: buildUpdateCommandPlan(preflight, {
          schemaVersion: 1,
          version: options.targetVersion ?? PLANBAN_VERSION,
          pluginVersion: options.targetVersion ?? PLANBAN_VERSION,
          mcpVersion: options.targetVersion ?? PLANBAN_VERSION,
          storageSchemaVersion: 2,
          minimumStorageSchemaVersion: 2,
          publishedAt: new Date().toISOString(),
          sourceUrl: "https://github.com/piercekearns/planban",
          releaseNotesUrl: `https://github.com/piercekearns/planban/releases/tag/v${options.targetVersion ?? PLANBAN_VERSION}`,
          targetRef: options.targetRef,
          targetCommit: options.targetCommit,
          summary: "Planban update",
          updatePrompt: "Update Planban.",
        }),
      }, options);
      return;
    }
    const snapshot = await runPlanbanUpdate({
      runtimeRoot: resolve(options.runtimeRoot ?? process.cwd()),
      currentBoardUrl: options.currentBoardUrl,
      latest: {
        schemaVersion: 1,
        version: options.targetVersion ?? PLANBAN_VERSION,
        pluginVersion: options.targetVersion ?? PLANBAN_VERSION,
        mcpVersion: options.targetVersion ?? PLANBAN_VERSION,
        storageSchemaVersion: 2,
        minimumStorageSchemaVersion: 2,
        publishedAt: new Date().toISOString(),
        sourceUrl: "https://github.com/piercekearns/planban",
        releaseNotesUrl: `https://github.com/piercekearns/planban/releases/tag/v${options.targetVersion ?? PLANBAN_VERSION}`,
        targetRef: options.targetRef,
        targetCommit: options.targetCommit,
        summary: "Planban update",
        updatePrompt: "Update Planban.",
      },
    });
    print(snapshot, options);
    if (snapshot.status === "failed") process.exitCode = 1;
  });

program
  .command("demo")
  .description("create or reuse the local Planban Demo board")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await ensureDemoBoard(), options);
  });

program
  .command("list-boards")
  .description("list registered Planban boards")
  .option("--include-archived", "include archived boards")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const boards = await listAllBoards();
    print(options.includeArchived ? boards : boards.filter((board) => !board.archivedAt), options);
  });

program
  .command("archive-board")
  .description("archive a whole Planban board without deleting its local planning state")
  .argument("<repoId>")
  .option("-o, --output <format>", "output format")
  .action(async (repoId, options) => {
    print(await archiveBoard(repoId), options);
  });

program
  .command("restore-board")
  .description("restore an archived Planban board")
  .argument("<repoId>")
  .option("-o, --output <format>", "output format")
  .action(async (repoId, options) => {
    print(await restoreBoard(repoId), options);
  });

program
  .command("duplicate-board")
  .description("duplicate a whole Planban board into a new local Planban board")
  .argument("<sourceRepoId>")
  .option("--repo-id <id>", "repo id for the duplicated board")
  .option("--title <title>", "title for the duplicated board")
  .option("-o, --output <format>", "output format")
  .action(async (sourceRepoId, options) => {
    print(await duplicateBoard({ sourceRepoId, repoId: options.repoId, title: options.title }), options);
  });

program
  .command("delete-board")
  .description("delete a whole Planban board after creating a timestamped local backup")
  .argument("<repoId>")
  .option("--yes", "confirm deletion")
  .option("-o, --output <format>", "output format")
  .action(async (repoId, options) => {
    if (!options.yes) throw new Error("Refusing to delete a board without --yes");
    print(await deleteBoard(repoId), options);
  });

program
  .command("serve")
  .option("--cwd <path>", "project directory")
  .option("--port <port>", "port", "4317")
  .option("--no-vite", "serve built static files instead of Vite middleware")
  .action(async (options) => {
    const server = await startServer({
      cwd: cwdOption(options.cwd),
      port: Number(options.port),
      useVite: options.vite,
    });
    process.stdout.write(`Planban listening at ${server.url}\n`);
    await new Promise(() => {
      // Keep the CLI process alive while the HTTP server owns the terminal.
    });
  });

program
  .command("list-cards")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const state = await loadState(cwdOption(options.cwd));
    print(state.roadmap.roadmapItems, options);
  });

program
  .command("get-card")
  .argument("<cardId>")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    const state = await loadState(cwdOption(options.cwd));
    const card = state.roadmap.roadmapItems.find((item) => item.id === cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);
    print(card, options);
  });

program
  .command("move-card")
  .argument("<cardId>")
  .requiredOption("--status <status>", "target status")
  .option("--after <cardId>", "insert after another card")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    print(
      await moveCard({
        cwd: cwdOption(options.cwd),
        cardId,
        status: requireStatus(options.status),
        afterId: options.after,
      }),
      options,
    );
  });

program
  .command("create-card")
  .argument("<title>")
  .option("--status <status>", "initial status")
  .option("--summary <summary>", "card summary")
  .option("--next-action <nextAction>", "next action")
  .option("--tag <tag>", "tag to attach; repeat for multiple tags", collectOption, [])
  .option("--metadata-json <json>", "metadata object as JSON")
  .option("--spec-file <path>", "read initial spec markdown from a file")
  .option("--plan-file <path>", "read initial plan markdown from a file and attach a plan doc")
  .option("--position <position>", "insert at top or bottom of the target status column")
  .option("--after <cardId>", "insert after another card in the target status column")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (title, options) => {
    print(
      await createCard({
        cwd: cwdOption(options.cwd),
        title,
        status: options.status ? requireStatus(options.status) : undefined,
        summary: options.summary,
        nextAction: options.nextAction,
        tags: options.tag,
        metadata: options.metadataJson ? parseMetadataJson(options.metadataJson) : undefined,
        specMarkdown: options.specFile ? readFileSync(resolve(options.specFile), "utf8") : undefined,
        planMarkdown: options.planFile ? readFileSync(resolve(options.planFile), "utf8") : undefined,
        position: options.position ? requireCreatePosition(options.position) : undefined,
        afterId: options.after,
      }),
      options,
    );
  });

for (const [command, status] of [
  ["complete-card", "complete"],
  ["archive-card", "archived"],
  ["restore-card", "pending"],
] as const) {
  program
    .command(command)
    .argument("<cardId>")
    .option("--cwd <path>", "project directory")
    .option("-o, --output <format>", "output format")
    .action(async (cardId, options) => {
      print(await setCardStatus(cwdOption(options.cwd), cardId, status), options);
    });
}

program
  .command("read-doc")
  .argument("<cardId>")
  .argument("<kind>")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, kind, options) => {
    if (kind !== "spec" && kind !== "plan") throw new Error("kind must be spec or plan");
    print(await readDoc({ cwd: cwdOption(options.cwd), cardId, kind }), options);
  });

program
  .command("write-doc")
  .argument("<cardId>")
  .argument("<kind>")
  .option("--cwd <path>", "project directory")
  .option("--file <path>", "read markdown from a file instead of stdin")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, kind, options) => {
    if (kind !== "spec" && kind !== "plan") throw new Error("kind must be spec or plan");
    const markdown = options.file ? readFileSync(options.file, "utf8") : await readStdin();
    print(await writeDoc({ cwd: cwdOption(options.cwd), cardId, kind, markdown }), options);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
