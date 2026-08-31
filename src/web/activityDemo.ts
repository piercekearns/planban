export const activityVariants = ["illumination", "aurora", "threads", "currents", "luminous-seam"] as const;

export type ActivityVariant = (typeof activityVariants)[number];
export type ActivityPhase = "active" | "cooldown" | "fading";
export type ActivityDemoMode = "compare" | "live" | "paused";

export interface ActivityPresentation {
  phase: ActivityPhase;
  variant: ActivityVariant;
}

export const activityVariantLabels: Record<ActivityVariant, string> = {
  illumination: "Soft illumination",
  aurora: "Aurora pools",
  threads: "Falling threads",
  currents: "Twin currents",
  "luminous-seam": "Luminous seam",
};

export function activityVariantForIndex(index: number): ActivityVariant {
  return activityVariants[((index % activityVariants.length) + activityVariants.length) % activityVariants.length]!;
}

export function activityLabIsEnabled(repoId: string, boardKind: string | undefined, search: string) {
  return repoId === "planban-demo"
    && boardKind === "demo"
    && new URLSearchParams(search).get("activityLab") === "1";
}

const phasePriority: Record<ActivityPhase, number> = {
  active: 3,
  cooldown: 2,
  fading: 1,
};

export function strongestActivityPhase(phases: Array<ActivityPhase | null | undefined>): ActivityPhase | null {
  let strongest: ActivityPhase | null = null;
  for (const phase of phases) {
    if (!phase) continue;
    if (!strongest || phasePriority[phase] > phasePriority[strongest]) strongest = phase;
  }
  return strongest;
}

export interface SimulatedActivityBurst {
  operationOffsetsMs: number[];
  operationDurationsMs: number[];
  nextBurstDelayMs: number;
}

export function simulatedActivityBurst(random = Math.random): SimulatedActivityBurst {
  const operationCount = random() < 0.62 ? 2 + Math.floor(random() * 3) : 1;
  let elapsedMs = 0;
  const operationOffsetsMs = Array.from({ length: operationCount }, (_, index) => {
    if (index === 0) return 0;
    elapsedMs += 25 + random() * 55;
    return Math.round(elapsedMs);
  });
  const operationDurationsMs = Array.from({ length: operationCount }, () => Math.round(35 + random() * 150));
  return {
    operationOffsetsMs,
    operationDurationsMs,
    nextBurstDelayMs: Math.round(1500 + random() * 2800),
  };
}
