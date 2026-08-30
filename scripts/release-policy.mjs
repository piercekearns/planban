export const BLACKSMITH_LINUX_RUNNER = "blacksmith-2vcpu-ubuntu-2404";
export const GITHUB_LINUX_RUNNER = "ubuntu-24.04";

export function githubRemoteOwner(remoteUrl) {
  const match = remoteUrl.trim().match(/github\.com(?::|\/)([^/]+)\//iu);
  return match?.[1]?.toLowerCase() ?? null;
}

export function expectedLinuxRunner(remoteUrl) {
  return githubRemoteOwner(remoteUrl) === "pjk-hq"
    ? BLACKSMITH_LINUX_RUNNER
    : GITHUB_LINUX_RUNNER;
}

function lockedInstallScripts(packageLock) {
  return Object.entries(packageLock.packages ?? {})
    .filter(([, entry]) => entry?.hasInstallScript === true)
    .map(([path, entry]) => {
      const marker = "node_modules/";
      const markerIndex = path.lastIndexOf(marker);
      const name = entry.name ?? (markerIndex >= 0 ? path.slice(markerIndex + marker.length) : path);
      return `${name}@${entry.version ?? "unknown"}`;
    })
    .sort();
}

export function auditReleasePolicy({ remoteUrl, workflows, packageJson, packageLock }) {
  const findings = [];
  const owner = githubRemoteOwner(remoteUrl);
  if (!owner) {
    findings.push(`origin is not a recognized GitHub remote: ${remoteUrl || "missing"}`);
  } else {
    const expectedRunner = expectedLinuxRunner(remoteUrl);
    for (const [path, source] of Object.entries(workflows)) {
      const runnerPattern = new RegExp(`^\\s*runs-on:\\s*${expectedRunner.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "mu");
      if (!runnerPattern.test(source)) {
        findings.push(`${path} must use runs-on: ${expectedRunner} for GitHub remote owner ${owner}`);
      }
    }
  }

  const reviewed = Object.entries(packageJson.allowScripts ?? {})
    .filter(([, allowed]) => allowed === true)
    .map(([entry]) => entry)
    .sort();
  const locked = lockedInstallScripts(packageLock);
  const lockedSet = new Set(locked);
  const reviewedSet = new Set(reviewed);
  const unreviewed = locked.filter((entry) => !reviewedSet.has(entry));
  const stale = reviewed.filter((entry) => !lockedSet.has(entry));
  if (unreviewed.length > 0) findings.push(`unreviewed dependency install scripts: ${unreviewed.join(", ")}`);
  if (stale.length > 0) findings.push(`stale dependency install-script allowlist entries: ${stale.join(", ")}`);
  return findings;
}
