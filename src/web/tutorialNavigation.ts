export function tutorialPath(mode = "first-run", returnRepoId?: string | null) {
  const params = new URLSearchParams({ mode });
  if (returnRepoId?.trim()) params.set("returnTo", returnRepoId.trim());
  return `/tutorial?${params.toString()}`;
}

export function tutorialExitRepoId(search: string, demoRepoId: string | null) {
  const returnRepoId = new URLSearchParams(search).get("returnTo")?.trim();
  return returnRepoId || demoRepoId;
}
