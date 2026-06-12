import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { updatePreflight, type PlanbanUpdatePreflight } from "./updatePreflight";
import type { PlanbanUpdateManifest } from "./version";

export type UpdateStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type UpdateRunStatus = "pending" | "running" | "succeeded" | "failed";

export interface UpdateCommandStep {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface UpdateRunStepSnapshot {
  id: string;
  label: string;
  status: UpdateStepStatus;
  command: string;
  cwd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface UpdateRunSnapshot {
  id: string;
  status: UpdateRunStatus;
  startedAt: string;
  completedAt: string | null;
  installShape: PlanbanUpdatePreflight["installShape"];
  targetVersion: string | null;
  targetRef: string | null;
  targetCommit: string | null;
  currentBoardUrl: string | null;
  restartRequired: boolean;
  message: string;
  error: string | null;
  steps: UpdateRunStepSnapshot[];
}

interface UpdateRunOptions {
  id?: string;
  runtimeRoot: string;
  codexHome?: string;
  latest?: PlanbanUpdateManifest | null;
  currentBoardUrl?: string | null;
  onSnapshot?: (snapshot: UpdateRunSnapshot) => void;
}

function isoNow() {
  return new Date().toISOString();
}

function publicStep(step: UpdateCommandStep): UpdateRunStepSnapshot {
  return {
    id: step.id,
    label: step.label,
    status: "pending",
    command: [step.command, ...step.args].join(" "),
    cwd: step.cwd ?? null,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    error: null,
  };
}

function marketplaceRoot(preflight: PlanbanUpdatePreflight) {
  return preflight.marketplace.root ? resolve(preflight.marketplace.root) : preflight.runtimeRoot;
}

function localRoot(preflight: PlanbanUpdatePreflight) {
  return preflight.git.root ? resolve(preflight.git.root) : preflight.runtimeRoot;
}

function generatedArtifactStep(root: string): UpdateCommandStep {
  return {
    id: "prepare-install-artifacts",
    label: "Prepare generated install artifacts",
    command: "node",
    args: ["scripts/prepare-local-update.mjs", root],
    cwd: root,
    timeoutMs: 30000,
  };
}

function verifyInstallStep(root: string, codexHome: string, targetVersion: string): UpdateCommandStep {
  return {
    id: "verify-install",
    label: "Verify updated Planban install",
    command: "node",
    args: [
      "--import",
      "tsx/esm",
      "scripts/verify-local-install.mjs",
      "--root",
      root,
      "--expected-version",
      targetVersion,
      "--codex-home",
      codexHome,
    ],
    cwd: root,
    env: { CODEX_HOME: codexHome },
    timeoutMs: 30000,
  };
}

export function buildUpdateCommandPlan(
  preflight: PlanbanUpdatePreflight,
  latest?: PlanbanUpdateManifest | null,
): UpdateCommandStep[] {
  if (!preflight.directUpdateAvailable) return [];

  const targetRef = latest?.targetRef?.trim() || "main";
  const targetCommit = latest?.targetCommit?.trim() || null;
  const targetVersion = latest?.version?.trim() || null;
  const codexEnv = { CODEX_HOME: preflight.codexHome };
  if (!targetVersion) return [];

  if (preflight.installShape === "git-marketplace") {
    const root = marketplaceRoot(preflight);
    const steps: UpdateCommandStep[] = [];
    if (preflight.git.generatedSafeDirtyFiles.length > 0) steps.push(generatedArtifactStep(root));
    return [
      ...steps,
      {
        id: "refresh-marketplace",
        label: "Refresh Planban marketplace snapshot",
        command: "codex",
        args: ["plugin", "marketplace", "upgrade", "planban"],
        env: codexEnv,
        timeoutMs: 120000,
      },
      {
        id: "install-dependencies",
        label: "Install Planban dependencies",
        command: "npm",
        args: ["install"],
        cwd: root,
        timeoutMs: 180000,
      },
      {
        id: "configure-plugin",
        label: "Configure Planban MCP runtime",
        command: "node",
        args: ["scripts/configure-local-plugin.mjs", root],
        cwd: root,
        timeoutMs: 30000,
      },
      {
        id: "install-plugin",
        label: "Refresh Planban plugin install",
        command: "codex",
        args: ["plugin", "add", "planban@planban"],
        cwd: root,
        env: codexEnv,
        timeoutMs: 60000,
      },
      verifyInstallStep(root, preflight.codexHome, targetVersion),
    ];
  }

  if (preflight.installShape === "local-clone") {
    const root = localRoot(preflight);
    const steps: UpdateCommandStep[] = [];
    if (preflight.git.generatedSafeDirtyFiles.length > 0) steps.push(generatedArtifactStep(root));
    return [
      ...steps,
      {
        id: "fetch-update",
        label: "Fetch Planban update",
        command: "git",
        args: ["fetch", "origin", targetRef],
        cwd: root,
        timeoutMs: 120000,
      },
      {
        id: "fast-forward",
        label: "Fast-forward local Planban clone",
        command: "git",
        args: ["merge", "--ff-only", targetCommit ?? "FETCH_HEAD"],
        cwd: root,
        timeoutMs: 60000,
      },
      {
        id: "install-dependencies",
        label: "Install Planban dependencies",
        command: "npm",
        args: ["install"],
        cwd: root,
        timeoutMs: 180000,
      },
      {
        id: "configure-plugin",
        label: "Configure Planban MCP runtime",
        command: "node",
        args: ["scripts/configure-local-plugin.mjs", root],
        cwd: root,
        timeoutMs: 30000,
      },
      {
        id: "install-plugin",
        label: "Refresh Planban plugin install",
        command: "codex",
        args: ["plugin", "add", "planban@planban"],
        cwd: root,
        env: codexEnv,
        timeoutMs: 60000,
      },
      verifyInstallStep(root, preflight.codexHome, targetVersion),
    ];
  }

  return [];
}

function runStep(step: UpdateCommandStep) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env ? { ...process.env, ...step.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = step.timeoutMs
      ? setTimeout(() => {
        child.kill("SIGTERM");
        rejectRun(new Error(`${step.label} timed out`));
      }, step.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function failureMessage(step: UpdateCommandStep, stdout: string, stderr: string) {
  const detail = (stderr || stdout).trim().split(/\r?\n/u).slice(-4).join("\n").trim();
  return detail ? `${step.label} failed:\n${detail}` : `${step.label} failed`;
}

export async function runPlanbanUpdate(options: UpdateRunOptions): Promise<UpdateRunSnapshot> {
  const preflightOptions = {
    runtimeRoot: options.runtimeRoot,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
  };
  const preflight = await updatePreflight(preflightOptions);
  if (!preflight.directUpdateAvailable) {
    throw new Error(preflight.blockedReasons[0] ?? "This Planban install is not eligible for direct update.");
  }

  const steps = buildUpdateCommandPlan(preflight, options.latest);
  if (steps.length === 0) throw new Error("No direct update command plan is available for this install.");

  const snapshot: UpdateRunSnapshot = {
    id: options.id ?? randomUUID(),
    status: "running",
    startedAt: isoNow(),
    completedAt: null,
    installShape: preflight.installShape,
    targetVersion: options.latest?.version ?? null,
    targetRef: options.latest?.targetRef ?? null,
    targetCommit: options.latest?.targetCommit ?? null,
    currentBoardUrl: options.currentBoardUrl ?? null,
    restartRequired: true,
    message: "Preparing Planban update...",
    error: null,
    steps: steps.map(publicStep),
  };

  const emit = () => options.onSnapshot?.({ ...snapshot, steps: snapshot.steps.map((step) => ({ ...step })) });
  emit();

  for (const step of steps) {
    const stepSnapshot = snapshot.steps.find((candidate) => candidate.id === step.id);
    if (!stepSnapshot) continue;
    stepSnapshot.status = "running";
    stepSnapshot.startedAt = isoNow();
    snapshot.message = step.label;
    emit();

    try {
      const result = await runStep(step);
      stepSnapshot.exitCode = result.exitCode;
      stepSnapshot.completedAt = isoNow();
      if (result.exitCode !== 0) {
        stepSnapshot.status = "failed";
        stepSnapshot.error = failureMessage(step, result.stdout, result.stderr);
        snapshot.status = "failed";
        snapshot.completedAt = isoNow();
        snapshot.error = stepSnapshot.error;
        snapshot.message = "Planban update failed.";
        emit();
        return snapshot;
      }
      stepSnapshot.status = "succeeded";
      snapshot.message = `${step.label} complete`;
      emit();
    } catch (error) {
      stepSnapshot.status = "failed";
      stepSnapshot.completedAt = isoNow();
      stepSnapshot.error = error instanceof Error ? error.message : `${step.label} failed`;
      snapshot.status = "failed";
      snapshot.completedAt = isoNow();
      snapshot.error = stepSnapshot.error;
      snapshot.message = "Planban update failed.";
      emit();
      return snapshot;
    }
  }

  snapshot.status = "succeeded";
  snapshot.completedAt = isoNow();
  snapshot.message = "Planban update installed. Restart Planban, then reopen this board to load the updated app.";
  emit();
  return snapshot;
}
