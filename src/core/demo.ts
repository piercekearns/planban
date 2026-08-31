import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "./paths";
import { registerBoardFromState } from "./registry";
import { createCard, initializeProject, loadState, moveCard, pathExists, readManifest, updateCard, writeDoc } from "./storage";
import type { PlanbanResolvedState, PlanbanStatus } from "./types";

const DEMO_REPO_ID = "planban-demo";
const DEMO_TITLE = "Planban Demo";

interface DemoCardSeed {
  title: string;
  legacyTitles?: string[];
  status: PlanbanStatus;
  summary: string;
  nextAction: string;
  spec: string;
  metadata?: Record<string, unknown>;
}

const DEMO_CARDS: DemoCardSeed[] = [
  {
    title: "Drag this card to In Progress",
    status: "up-next",
    summary: "Try the board by dragging this card into In Progress.",
    nextAction: "Move this card into In Progress, then ask your agent to summarize the board.",
    spec: `# Drag This Card To In Progress

## Purpose

Planban is a local roadmap board for agent-led work.

## Current state

This section is authoritative for the tutorial. The card is ready to move.

## Agent reference

Start here: drag this card into In Progress. The board will save the status and order for you.
`,
  },
  {
    title: "Copy a reference into agent chat",
    legacyTitles: ["Open this roadmap item in Codex"],
    status: "up-next",
    summary: "Use a precise Item reference to carry work into any agent surface.",
    nextAction: "Copy this Item reference and paste it into the agent chat where you want to work.",
    spec: `# Copy A Reference Into Agent Chat

## Purpose

Planban Items can be referenced precisely without tying work to one agent host or thread launcher.

## Current state

This section is authoritative for the tutorial. The Item is ready to reference.

## Agent reference

Use Copy Reference on the card or in its details, then paste the result into the agent chat where you want to continue.
`,
  },
  {
    title: "Mark a card Complete when you are done",
    status: "in-progress",
    summary: "Completion should be intentional, especially when an agent is doing the work.",
    nextAction: "Drag this In Progress card to Complete once you are happy with the work.",
    spec: `# Mark A Card Complete When You Are Done

## Purpose

Planban treats Complete as a deliberate user-controlled transition.

## Current state

This section is authoritative for the tutorial. The card is ready for user-controlled completion.

## Agent reference

Agents can run tests and prepare work for review, but your board should only mark a real task Complete when you confirm it is done. Try that here by dragging this In Progress card into Complete.
`,
  },
  {
    title: "Send feedback from the toolbar",
    status: "pending",
    summary: "Feedback is welcome. Feedback / Bug in More is for bugs, requests, rough edges, or reactions.",
    nextAction: "Open More, choose Feedback / Bug, and let your agent prepare it before anything is filed publicly.",
    spec: `# Send Feedback From The Toolbar

## Purpose

Planban keeps Feedback / Bug inside the Board's More menu.

## Current state

This section is authoritative for the tutorial. The feedback action is available.

## Agent reference

Feedback is welcome. If you find a bug, want a feature, feel confused, or want to share what worked well, open More and choose Feedback / Bug.

Planban creates an agent-ready prompt that explicitly invokes the installed Planban Feedback skill before anything is filed publicly. In Codex, Planban Feedback is also available from the /planban menu or through /Planban Feedback.
`,
  },
  {
    title: "Ask your agent to create roadmap items from your plans",
    legacyTitles: ["Ask Codex to create roadmap items from your plans"],
    status: "pending",
    summary: "Bring existing project context from docs, issues, Notion, Jira, Linear, or plain notes.",
    nextAction: "Give your agent the current planning context and ask it to draft Planban roadmap items for review.",
    spec: `# Ask Your Agent To Create Roadmap Items From Your Plans

## Purpose

If you already track work somewhere else, you do not need a perfect migration file.

## Current state

This section is authoritative for the tutorial. Planban is ready to receive planning context.

## Agent reference

Give your agent context from repo docs, GitHub Issues, Notion, Jira, Linear, copied notes, or a plain-language project update. Then ask it to draft Planban roadmap items that you can review and edit.
`,
  },
];

export function demoProjectCwd(): string {
  return join(defaultPlanbanRoot(), "demo", DEMO_REPO_ID);
}

async function seedDemoCards(cwd: string): Promise<PlanbanResolvedState> {
  let state = await loadState(cwd);

  for (const seed of DEMO_CARDS) {
    const existing = state.roadmap.roadmapItems.find((item) =>
      item.title === seed.title || seed.legacyTitles?.includes(item.title),
    );
    if (existing) {
      state = await updateCard({
        cwd,
        cardId: existing.id,
        title: seed.title,
        summary: seed.summary,
        nextAction: seed.nextAction,
        actor: "system",
      });
    } else {
      state = await createCard({
        cwd,
        title: seed.title,
        status: seed.status,
        summary: seed.summary,
        nextAction: seed.nextAction,
        metadata: seed.metadata,
      });
    }
    const card = state.roadmap.roadmapItems.find((item) => item.title === seed.title);
    if (!card) throw new Error(`Demo card was not created: ${seed.title}`);
    if (card.status !== seed.status) {
      state = await moveCard({
        cwd,
        cardId: card.id,
        status: seed.status,
        actor: "system",
      });
    }
    await writeDoc({
      cwd,
      cardId: card.id,
      kind: "spec",
      markdown: seed.spec,
      history: {
        actor: "system",
        operation: "demo.seed.doc",
        summary: `Seeded ${seed.title} demo spec`,
        affectedCards: [card.id],
        affectedDocs: [{ cardId: card.id, kind: "spec", path: card.specDoc }],
      },
    });
  }

  state = await updateCard({
    cwd,
    cardId: "drag-this-card-to-in-progress",
    metadata: { demoPrimaryAction: true },
    actor: "system",
  });
  return state;
}

export async function ensureDemoBoard(): Promise<PlanbanResolvedState> {
  const cwd = demoProjectCwd();
  await mkdir(cwd, { recursive: true });

  const manifest = await readManifest(cwd);
  if (!manifest || !manifest.enabled) {
    await initializeProject({
      cwd,
      repoId: DEMO_REPO_ID,
      title: DEMO_TITLE,
      updateAgents: false,
    });
  } else if (!(await pathExists(join(defaultPlanbanRoot(), "repos", manifest.repoId, "roadmap.json")))) {
    await initializeProject({
      cwd,
      repoId: DEMO_REPO_ID,
      title: DEMO_TITLE,
      updateAgents: false,
    });
  }

  const state = await seedDemoCards(cwd);
  await registerBoardFromState(state, { kind: "demo" });
  return state;
}
