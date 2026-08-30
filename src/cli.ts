import { Command, Option } from "commander";
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
  setCardParent,
  cardAncestry,
  writeDoc,
  createCard,
  createCards,
  createGroup,
  updateCard,
  exportFlatVersion1,
  reconstructHierarchy,
} from "./core/storage";
import { PLANBAN_STATUSES, type PlanbanStatus } from "./core/types";
import { queryWorkItems, workItemQueryFromSearchParams } from "./core/workItemQuery";
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

function parseBooleanOption(value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error('Invalid boolean. Expected "true" or "false".');
  }
  return value === "true";
}

function parseRevisionOption(value: string): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("Invalid revision. Expected a non-negative integer.");
  }
  return revision;
}

function parsePositiveInteger(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("Expected a positive integer.");
  return number;
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
  .command("query-cards")
  .description("search and filter Work Items without changing roadmap state")
  .option("--search <text>", "search id, title, summary, next action, and tags")
  .option("--projection <projection>", "main, group, or flattened")
  .option("--group <cardId>", "selected Group for Group projection or scope")
  .addOption(new Option("--programme <cardId>", "deprecated alias for --group").hideHelp())
  .option("--scope <scope>", "projection, root, owned, leaf, or selected-group")
  .option("--group-role <role>", "any, group, or item-only")
  .addOption(new Option("--programme-role <role>", "deprecated alias for --group-role").hideHelp())
  .option("--status <status>", "Workflow Status filter; repeat for multiple", collectOption, [])
  .option("--blocked <state>", "any, blocked, or unblocked")
  .option("--tag <tag>", "tag filter; repeat for multiple", collectOption, [])
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const params = new URLSearchParams();
    if (options.search) params.set("q", options.search);
    if (options.projection) params.set("projection", options.projection);
    if (options.group ?? options.programme) params.set("groupId", options.group ?? options.programme);
    if (options.scope) params.set("scope", options.scope);
    if (options.groupRole ?? options.programmeRole) params.set("groupRole", options.groupRole ?? options.programmeRole);
    for (const status of options.status) params.append("status", status);
    if (options.blocked) params.set("blocked", options.blocked);
    for (const tag of options.tag) params.append("tag", tag);
    const state = await loadState(cwdOption(options.cwd));
    print({ revision: state.roadmap.revision, ...queryWorkItems(state.roadmap.roadmapItems, workItemQueryFromSearchParams(params)) }, options);
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
    print({ ...card, ancestry: cardAncestry(state.roadmap, cardId) }, options);
  });

program
  .command("move-card")
  .argument("<cardId>")
  .option("--status <status>", "target status")
  .option("--parent <cardId>", "move this Item into an existing Group")
  .option("--board", "move to the main board")
  .option("--after <cardId>", "place after a sibling in the target status")
  .option("--first", "place first in the target ownership and status scope")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    if (options.parent && options.board) throw new Error("Choose at most one of --parent or --board.");
    if (options.after && options.first) throw new Error("Choose at most one of --after or --first.");
    if (!options.status && !options.parent && !options.board && !options.after && !options.first) {
      throw new Error("Provide --status, --parent, --board, --after, or --first.");
    }
    print(
      await moveCard({
        cwd: cwdOption(options.cwd),
        cardId,
        status: options.status ? requireStatus(options.status) : undefined,
        parentId: options.parent ? options.parent : options.board ? null : undefined,
        afterId: options.after ? options.after : options.first ? null : undefined,
        baseRevision: options.baseRevision,
      }),
      options,
    );
  });

program
  .command("update-card")
  .argument("<cardId>")
  .option("--title <title>", "replace the card title")
  .option("--summary <summary>", "replace the card summary or Group objective")
  .option("--clear-summary", "clear the card summary or Group objective")
  .option("--next-action <nextAction>", "replace the next action")
  .option("--clear-next-action", "clear the next action")
  .option("--tag <tag>", "replacement tag; repeat for multiple tags", collectOption)
  .option("--blocked-by <cardId>", "replace the blocking card")
  .option("--clear-blocked-by", "clear the blocking card")
  .option("--metadata-json <json>", "replace metadata with a JSON object")
  .option("--clear-metadata", "clear card metadata")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    if (options.summary !== undefined && options.clearSummary) throw new Error("Choose at most one of --summary or --clear-summary.");
    if (options.nextAction !== undefined && options.clearNextAction) throw new Error("Choose at most one of --next-action or --clear-next-action.");
    if (options.blockedBy !== undefined && options.clearBlockedBy) throw new Error("Choose at most one of --blocked-by or --clear-blocked-by.");
    if (options.metadataJson !== undefined && options.clearMetadata) throw new Error("Choose at most one of --metadata-json or --clear-metadata.");
    if (options.title === undefined
      && options.summary === undefined && !options.clearSummary
      && options.nextAction === undefined && !options.clearNextAction
      && options.tag === undefined
      && options.blockedBy === undefined && !options.clearBlockedBy
      && options.metadataJson === undefined && !options.clearMetadata) {
      throw new Error("Provide a card field to update.");
    }
    print(await updateCard({
      cwd: cwdOption(options.cwd),
      cardId,
      title: options.title,
      summary: options.clearSummary ? null : options.summary,
      nextAction: options.clearNextAction ? null : options.nextAction,
      tags: options.tag,
      blockedBy: options.clearBlockedBy ? null : options.blockedBy,
      metadata: options.clearMetadata ? null : options.metadataJson !== undefined ? parseMetadataJson(options.metadataJson) : undefined,
      baseRevision: options.baseRevision,
      actor: "agent",
    }), options);
  });

program
  .command("set-card-parent")
  .argument("<cardId>")
  .option("--parent <cardId>", "move this Item into a root Group")
  .option("--board", "move to the main board")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    if ((options.parent ? 1 : 0) + (options.board ? 1 : 0) !== 1) {
      throw new Error("Choose exactly one of --parent or --board.");
    }
    print(await setCardParent({
      cwd: cwdOption(options.cwd),
      cardId,
      parentId: options.board ? null : options.parent,
      baseRevision: options.baseRevision,
    }), options);
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
  .option("--parent <cardId>", "create inside a Group")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection", parseRevisionOption)
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
        parentId: options.parent,
        baseRevision: options.baseRevision,
      }),
      options,
    );
  });

function configureCreateGroupCommand(command: Command) {
  return command
    .argument("<title>")
    .option("--summary <summary>", "Group objective; agents should normally provide one unless explicitly asked not to")
    .option("--next-action <nextAction>", "next action")
    .option("--status <status>", "initial Group status")
    .option("--item <cardId>", "root Item to place inside; repeat for multiple Items", collectOption, [])
    .addOption(new Option("--deliverable <cardId>", "deprecated alias for --item").argParser(collectOption).default([]).hideHelp())
    .option("--anchor <cardId>", "initial Item whose Main Board position the Group takes")
    .option("--spec-file <path>", "read initial Group spec markdown from a file")
    .option("--plan-file <path>", "read initial Group plan markdown from a file")
    .option("--base-revision <revision>", "roadmap revision for stale-write protection", parseRevisionOption)
    .option("--cwd <path>", "project directory")
    .option("-o, --output <format>", "output format")
    .action(async (title, options) => {
      print(await createGroup({
        cwd: cwdOption(options.cwd),
        title,
        summary: options.summary,
        nextAction: options.nextAction,
        status: options.status ? requireStatus(options.status) : undefined,
        itemIds: [...options.item, ...options.deliverable],
        anchorId: options.anchor,
        specMarkdown: options.specFile ? readFileSync(resolve(options.specFile), "utf8") : undefined,
        planMarkdown: options.planFile ? readFileSync(resolve(options.planFile), "utf8") : undefined,
        baseRevision: options.baseRevision,
      }), options);
    });
}

configureCreateGroupCommand(program.command("create-group"));
configureCreateGroupCommand(program.command("create-programme", { hidden: true }));

program
  .command("create-cards")
  .requiredOption("--title <title>", "title to create; repeat for multiple cards", collectOption, [])
  .option("--status <status>", "initial status")
  .option("--parent <cardId>", "create inside a Group")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await createCards({
      cwd: cwdOption(options.cwd), titles: options.title,
      status: options.status ? requireStatus(options.status) : undefined,
      parentId: options.parent, baseRevision: options.baseRevision,
    }), options);
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

program
  .command("export-flat-v1")
  .requiredOption("--export-id <id>", "stable name for the recoverable export")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await exportFlatVersion1({ cwd: cwdOption(options.cwd), exportId: options.exportId, actor: "agent" }), options);
  });

program
  .command("reconstruct-hierarchy")
  .requiredOption("--file <path>", "JSON file containing { groups: [{ id, childIds }] }")
  .requiredOption("--base-revision <revision>", "roadmap revision for stale-write protection", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const payload = JSON.parse(readFileSync(resolve(options.file), "utf8")) as {
      groups?: Array<{ id: string; childIds: string[] }>;
      programmes?: Array<{ id: string; childIds: string[] }>;
    };
    print(await reconstructHierarchy({
      cwd: cwdOption(options.cwd), groups: payload.groups ?? payload.programmes ?? [], baseRevision: options.baseRevision, actor: "agent",
    }), options);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
