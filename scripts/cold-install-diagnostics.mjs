import { open, readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Publish a bounded event projection, never raw npm logs, URLs, arguments or paths.
export function projectNpmTail(text) {
  return text.split(/\r?\n/u).slice(-128).flatMap((line) => {
    const prefix = /^(\d+) (timing|http|verbose|silly|error|warn|info) /u.exec(line);
    if (!prefix) return [];
    const event = { sequence: Number(prefix[1]), level: prefix[2] };
    if (!Number.isSafeInteger(event.sequence)) return [];
    const timing = / Completed in (\d+)ms$/u.exec(line);
    if (prefix[2] === "timing" && timing) {
      return [{ ...event, kind: "timing", elapsedMs: Number(timing[1]) }];
    }
    const fetch = /http fetch (GET|POST) (\d{3}) https?:\/\/\S+ (\d+)ms(?: |$)/u.exec(line);
    if (prefix[2] === "http" && fetch) {
      return [{ ...event, kind: "fetch", method: fetch[1], status: Number(fetch[2]), elapsedMs: Number(fetch[3]) }];
    }
    const kind = / packumentCache /u.test(line) ? "package-cache"
      : / fetch manifest /u.test(line) ? "manifest"
      : / (?:placeDep|reify|idealTree) /u.test(line) ? "dependency-tree"
      : prefix[2] === "error" ? "error" : prefix[2] === "warn" ? "warning" : "other";
    return [{ ...event, kind }];
  }).slice(-32);
}

export async function captureColdInstallDiagnostics(logDirectory, destination) {
  if (!destination) return;
  const names = (await readdir(logDirectory).catch(() => []))
    .filter((name) => /^\d{4}-\d{2}-\d{2}T[\d_]+Z-debug-\d+\.log$/u.test(name)).sort().slice(-3);
  const logs = [];
  for (const name of names) {
    const path = join(logDirectory, name);
    // Only regular fixture-owned files; don't follow injected symbolic links.
    if (!(await lstat(path)).isFile()) continue;
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 65536));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      logs.push({ bytes: size, tailBytes: bytesRead, events: projectNpmTail(text) });
    } finally { await handle.close(); }
  }
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "cold-install-npm-events.json"), JSON.stringify({ version: 1, logs }, null, 2) + "\n");
}

export async function withColdInstallDiagnostics(action, logDirectory, destination) {
  try { return await action(); }
  catch (original) {
    // Diagnostics must never replace the stage failure or prevent lifecycle cleanup.
    try { await captureColdInstallDiagnostics(logDirectory, destination); } catch { /* original failure wins */ }
    throw original;
  }
}
