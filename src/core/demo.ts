import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "./paths";
import { createCard, initializeProject, loadState, pathExists, readManifest, updateCard, writeDoc } from "./storage";
import type { PlanbanResolvedState, PlanbanStatus } from "./types";

const DEMO_REPO_ID = "planban-demo";
const DEMO_TITLE = "Planban Demo";

interface DemoCardSeed {
  title: string;
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

Planban is a local roadmap board for agent-led work.

Start here: drag this card into In Progress. The board will save the status and order for you.
`,
  },
  {
    title: "Open this roadmap item in Codex",
    status: "up-next",
    summary: "Use a roadmap item to start an agent thread with the right context.",
    nextAction: "Open this item in Codex, then hit enter to test out the generated prompt.",
    spec: `# Open This Roadmap Item In Codex

Hit enter to test out this prompt.

Roadmap items can carry enough context for an agent to start work without rediscovering the project.

This demo prompt should open the Planban board, move this roadmap item into In Progress, update the card details, and tell you the new thread was created successfully.
`,
    metadata: {
      demoCodexPrompt: true,
      demoSuccessMessage: "New thread created successfully. Check the In Progress column in your Planban Demo board.",
    },
  },
  {
    title: "Mark a card Complete when you are done",
    status: "pending",
    summary: "Completion should be intentional, especially when an agent is doing the work.",
    nextAction: "When a task has been reviewed, move it to Complete.",
    spec: `# Mark A Card Complete When You Are Done

Planban treats Complete as a deliberate user-controlled transition.

Agents can run tests and prepare work for review, but your board should only mark a real task Complete when you confirm it is done.
`,
  },
  {
    title: "Send feedback from the toolbar",
    status: "pending",
    summary: "Feedback is welcome. The toolbar icon is there for bugs, requests, rough edges, or reactions.",
    nextAction: "If you want to share feedback, select the toolbar icon and let your agent prepare it before anything is filed publicly.",
    spec: `# Send Feedback From The Toolbar

Planban has a feedback button in the board toolbar.

Feedback is welcome. If you find a bug, want a feature, feel confused, or want to share what worked well, use the toolbar icon.

Planban creates a Codex-ready prompt so your agent can turn rough notes into the right feedback format before anything is filed publicly.
`,
  },
  {
    title: "Ask Codex to create roadmap items from your plans",
    status: "pending",
    summary: "Bring existing project context from docs, issues, Notion, Jira, Linear, or plain notes.",
    nextAction: "Give Codex your current planning context and ask it to draft Planban roadmap items for review.",
    spec: `# Ask Codex To Create Roadmap Items From Your Plans

If you already track work somewhere else, you do not need a perfect migration file.

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
    const existing = state.roadmap.roadmapItems.find((item) => item.title === seed.title);
    if (existing) {
      state = await updateCard({
        cwd,
        cardId: existing.id,
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

  return await seedDemoCards(cwd);
}
