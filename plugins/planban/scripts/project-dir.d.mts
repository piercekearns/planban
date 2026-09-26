export type PlanbanProjectDiscovery = {
  projectDir: string;
  requestedCwd: string;
  via: "cwd" | "ancestor" | "worktree" | "none";
  worktreeDir?: string;
};
export function mainCheckoutForWorktree(gitTop: string): string | null;
export function resolvePlanbanProjectDir(cwdInput: string): PlanbanProjectDiscovery;
export function planbanProjectDir(cwdInput: string): string;
