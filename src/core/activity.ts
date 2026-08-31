export const PLANBAN_ACTIVITY_HOLD_MS = 420;
export const PLANBAN_ACTIVITY_FADE_MS = 780;
export const PLANBAN_ACTIVITY_TAIL_MS = PLANBAN_ACTIVITY_HOLD_MS + PLANBAN_ACTIVITY_FADE_MS;
export const PLANBAN_ACTIVITY_LEASE_TTL_MS = 8_000;

export interface PlanbanActivitySnapshot {
  repoId: string;
  cardId: string;
  activeCount: number;
  lastStartedAt: number;
  endedAt: number | null;
  removeAt: number | null;
}

interface ActivityTarget {
  repoId: string;
  cardId: string;
  leases: Map<string, number>;
  lastStartedAt: number;
  endedAt: number | null;
  removeAt: number | null;
}

function targetKey(repoId: string, cardId: string) {
  return `${repoId}\u0000${cardId}`;
}

export class PlanbanActivityStore {
  private readonly targets = new Map<string, ActivityTarget>();

  begin(input: { repoId: string; cardId: string; leaseId: string; now?: number; ttlMs?: number }) {
    const now = input.now ?? Date.now();
    const key = targetKey(input.repoId, input.cardId);
    const target = this.targets.get(key) ?? {
      repoId: input.repoId,
      cardId: input.cardId,
      leases: new Map<string, number>(),
      lastStartedAt: now,
      endedAt: null,
      removeAt: null,
    };
    target.leases.set(input.leaseId, now + (input.ttlMs ?? PLANBAN_ACTIVITY_LEASE_TTL_MS));
    target.lastStartedAt = now;
    target.endedAt = null;
    target.removeAt = null;
    this.targets.set(key, target);
  }

  end(input: { repoId: string; cardId: string; leaseId: string; now?: number }) {
    const now = input.now ?? Date.now();
    const target = this.targets.get(targetKey(input.repoId, input.cardId));
    if (!target || !target.leases.delete(input.leaseId)) return false;
    if (target.leases.size === 0) {
      target.endedAt = now;
      target.removeAt = now + PLANBAN_ACTIVITY_TAIL_MS;
    }
    return true;
  }

  prune(now = Date.now()) {
    let changed = false;
    for (const [key, target] of this.targets) {
      for (const [leaseId, expiresAt] of target.leases) {
        if (expiresAt <= now) {
          target.leases.delete(leaseId);
          changed = true;
        }
      }
      if (target.leases.size === 0 && target.endedAt === null) {
        target.endedAt = now;
        target.removeAt = now + PLANBAN_ACTIVITY_TAIL_MS;
        changed = true;
      }
      if (target.leases.size === 0 && target.removeAt !== null && target.removeAt <= now) {
        this.targets.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  snapshot(now = Date.now()): PlanbanActivitySnapshot[] {
    this.prune(now);
    return [...this.targets.values()]
      .map((target) => ({
        repoId: target.repoId,
        cardId: target.cardId,
        activeCount: target.leases.size,
        lastStartedAt: target.lastStartedAt,
        endedAt: target.endedAt,
        removeAt: target.removeAt,
      }))
      .sort((left, right) => left.repoId.localeCompare(right.repoId) || left.cardId.localeCompare(right.cardId));
  }
}

export function activityPhaseAt(activity: PlanbanActivitySnapshot, now = Date.now()): "active" | "cooldown" | "fading" | null {
  if (activity.activeCount > 0 || activity.endedAt === null) return "active";
  const elapsed = now - activity.endedAt;
  if (elapsed < PLANBAN_ACTIVITY_HOLD_MS) return "cooldown";
  if (elapsed < PLANBAN_ACTIVITY_TAIL_MS) return "fading";
  return null;
}
