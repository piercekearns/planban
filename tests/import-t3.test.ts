import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { importT3 } from "../src/core/importT3";

const repoId = "planban-t3-import-test";
const sourceRepo = "/tmp/planban-t3-source";
const t3Root = "/tmp/planban-t3-root";
const planbanHome = "/tmp/planban-t3-home";
const planbanRoot = join(planbanHome, "repos", repoId);
const t3RoadmapPath = join(t3Root, "repos", repoId, "roadmap.json");

test.beforeEach(async () => {
  process.env.PLANBAN_HOME = planbanHome;
  await rm(sourceRepo, { recursive: true, force: true });
  await rm(t3Root, { recursive: true, force: true });
  await rm(planbanHome, { recursive: true, force: true });
  await mkdir(join(sourceRepo, ".t3plan"), { recursive: true });
  await mkdir(join(t3Root, "repos", repoId, "docs", "alpha"), { recursive: true });

  await writeFile(
    join(sourceRepo, ".t3plan", "project.json"),
    JSON.stringify({ version: 1, repoId, enabled: true }, null, 2),
    "utf8",
  );
  await writeFile(join(t3Root, "repos", repoId, "docs", "alpha", "spec.md"), "# Alpha Spec\n", "utf8");
  await writeFile(join(t3Root, "repos", repoId, "docs", "alpha", "plan.md"), "# Alpha Plan\n", "utf8");
  await writeRoadmap([
    {
      id: "alpha",
      title: "Alpha",
      status: "up-next",
      priority: 3,
      summary: "Imported summary",
      nextAction: "Imported next action",
      tags: ["migration"],
      specDoc: "docs/alpha/spec.md",
      planDoc: "docs/alpha/plan.md",
    },
  ]);
});

test.afterEach(() => {
  delete process.env.PLANBAN_HOME;
});

async function writeRoadmap(roadmapItems: unknown[]) {
  await writeFile(
    t3RoadmapPath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-06-09T12:00:00.000Z",
        project: {
          id: repoId,
          title: "T3 Import Test",
          status: "in-progress",
          description: "Synthetic import fixture",
          tags: ["test"],
        },
        roadmapItems,
      },
      null,
      2,
    ),
    "utf8",
  );
}

test("dry-run reports import without writing Planban state", async () => {
  const oldRoot = process.env.T3PLAN_ROOT;
  process.env.T3PLAN_ROOT = t3Root;
  try {
    const report = await importT3({ from: sourceRepo, dryRun: true, updateAgents: false });
    assert.equal(report.dryRun, true);
    assert.equal(report.cards, 1);
    assert.equal(report.specs, 1);
    assert.equal(report.plans, 1);
    await assert.rejects(readFile(join(sourceRepo, ".planban", "project.json"), "utf8"));
    await assert.rejects(readFile(join(planbanRoot, "roadmap.json"), "utf8"));
  } finally {
    if (oldRoot === undefined) delete process.env.T3PLAN_ROOT;
    else process.env.T3PLAN_ROOT = oldRoot;
  }
});

test("apply writes Planban files and copies linked docs without mutating T3 files", async () => {
  const originalManifest = await readFile(join(sourceRepo, ".t3plan", "project.json"), "utf8");
  const originalRoadmap = await readFile(t3RoadmapPath, "utf8");
  const oldRoot = process.env.T3PLAN_ROOT;
  process.env.T3PLAN_ROOT = t3Root;

  try {
    const report = await importT3({ from: sourceRepo, dryRun: false, updateAgents: false });
    assert.equal(report.dryRun, false);
    assert.equal(report.cards, 1);
    assert.equal(report.specs, 1);
    assert.equal(report.plans, 1);

    const manifest = JSON.parse(await readFile(join(sourceRepo, ".planban", "project.json"), "utf8"));
    const roadmap = JSON.parse(await readFile(join(planbanRoot, "roadmap.json"), "utf8"));
    assert.equal(manifest.repoId, repoId);
    assert.equal(roadmap.roadmapItems[0].id, "alpha");
    assert.equal(roadmap.roadmapItems[0].status, "up-next");
    assert.equal(roadmap.roadmapItems[0].priority, 3);
    assert.equal(await readFile(join(planbanRoot, "items", "alpha", "spec.md"), "utf8"), "# Alpha Spec\n");
    assert.equal(await readFile(join(planbanRoot, "items", "alpha", "plan.md"), "utf8"), "# Alpha Plan\n");

    assert.equal(await readFile(join(sourceRepo, ".t3plan", "project.json"), "utf8"), originalManifest);
    assert.equal(await readFile(t3RoadmapPath, "utf8"), originalRoadmap);
  } finally {
    if (oldRoot === undefined) delete process.env.T3PLAN_ROOT;
    else process.env.T3PLAN_ROOT = oldRoot;
  }
});

test("shared T3 docs are copied into each item folder", async () => {
  await mkdir(join(t3Root, "repos", repoId, "docs", "shared"), { recursive: true });
  await writeFile(join(t3Root, "repos", repoId, "docs", "shared", "spec.md"), "# Project Spec\n", "utf8");
  await writeFile(join(t3Root, "repos", repoId, "docs", "shared", "plan.md"), "# Project Plan\n", "utf8");
  await writeRoadmap([
    {
      id: "alpha",
      title: "Alpha",
      status: "up-next",
      priority: 1,
      summary: "Alpha summary",
      nextAction: "Ship alpha",
      tags: ["first"],
      specDoc: "docs/shared/spec.md",
      planDoc: "docs/shared/plan.md",
    },
    {
      id: "beta",
      title: "Beta",
      status: "pending",
      priority: 2,
      summary: "Beta summary",
      nextAction: "Ship beta",
      tags: ["second"],
      specDoc: "docs/shared/spec.md",
      planDoc: "docs/shared/plan.md",
    },
  ]);

  const oldRoot = process.env.T3PLAN_ROOT;
  process.env.T3PLAN_ROOT = t3Root;

  try {
    const report = await importT3({ from: sourceRepo, dryRun: false, updateAgents: false });
    assert.equal(report.cards, 2);
    assert.equal(report.specs, 2);
    assert.equal(report.plans, 2);

    const roadmap = JSON.parse(await readFile(join(planbanRoot, "roadmap.json"), "utf8"));
    assert.equal(roadmap.roadmapItems[0].specDoc, "items/alpha/spec.md");
    assert.equal(roadmap.roadmapItems[0].planDoc, "items/alpha/plan.md");
    assert.equal(roadmap.roadmapItems[1].planDoc, "items/beta/plan.md");

    const alphaSpec = await readFile(join(planbanRoot, "items", "alpha", "spec.md"), "utf8");
    const betaPlan = await readFile(join(planbanRoot, "items", "beta", "plan.md"), "utf8");
    assert.equal(alphaSpec, "# Project Spec\n");
    assert.equal(betaPlan, "# Project Plan\n");
  } finally {
    if (oldRoot === undefined) delete process.env.T3PLAN_ROOT;
    else process.env.T3PLAN_ROOT = oldRoot;
  }
});

test("cards without source docs do not get generated placeholder docs", async () => {
  await writeRoadmap([
    {
      id: "alpha",
      title: "Alpha",
      status: "up-next",
      priority: 1,
      summary: "Alpha summary",
      nextAction: "Ship alpha",
      tags: ["first"],
      specDoc: null,
      planDoc: null,
    },
  ]);

  const oldRoot = process.env.T3PLAN_ROOT;
  process.env.T3PLAN_ROOT = t3Root;

  try {
    const report = await importT3({ from: sourceRepo, dryRun: false, updateAgents: false });
    assert.equal(report.cards, 1);
    assert.equal(report.specs, 0);
    assert.equal(report.plans, 0);

    const roadmap = JSON.parse(await readFile(join(planbanRoot, "roadmap.json"), "utf8"));
    assert.equal(roadmap.roadmapItems[0].specDoc, null);
    assert.equal(roadmap.roadmapItems[0].planDoc, null);
    await assert.rejects(readFile(join(planbanRoot, "items", "alpha", "spec.md"), "utf8"));
  } finally {
    if (oldRoot === undefined) delete process.env.T3PLAN_ROOT;
    else process.env.T3PLAN_ROOT = oldRoot;
  }
});
