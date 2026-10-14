// How to run Planban's command line on this computer, for messages that tell
// someone to run it. Installs through Codex or Claude Code don't put `planban`
// on the PATH, so the message names the installed script unless they did.
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/planban.mjs");

function onPath(name: string): boolean {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Not in this directory.
    }
  }
  return false;
}

let cached: string | undefined;

/** `planban` when it is installed as a command, otherwise `node "<this install>/bin/planban.mjs"`. */
export function planbanCommand(): string {
  cached ??= onPath(process.platform === "win32" ? "planban.cmd" : "planban") ? "planban" : `node "${SCRIPT}"`;
  return cached;
}
