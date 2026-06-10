import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDemoBoard } from "./core/demo";
import { importT3 } from "./core/importT3";
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
program.name("planban").description("Codex-native local planning board").version("0.1.0");

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
  .command("demo")
  .description("create or reuse the local Planban Demo board")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await ensureDemoBoard(), options);
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

program
  .command("import-t3")
  .requiredOption("--from <path>", "T3 Plan repo path")
  .option("--dry-run", "preview without writing")
  .option("--apply", "write Planban files")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const dryRun = options.apply ? false : true;
    print(await importT3({ from: options.from, dryRun }), options);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
