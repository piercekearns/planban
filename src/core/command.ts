// How to run Planban's command line on this computer, for messages that tell
// someone to run it. Installs through Codex or Claude Code don't put `planban`
// on the PATH, so the message names the installed script unless they did.
//
// This module is also bundled into the board page, so it uses no static Node
// imports: in a browser it simply answers `planban`.

type NodeModules = {
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  url: typeof import("node:url");
};

function nodeModules(): NodeModules | null {
  const load = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  if (typeof load !== "function") return null;
  return { fs: load("node:fs") as NodeModules["fs"], path: load("node:path") as NodeModules["path"], url: load("node:url") as NodeModules["url"] };
}

/** Quotes one argument so a shell runs it as written, whatever the folder name holds. */
export function shellQuote(value: string, windows = (globalThis as { process?: { platform?: string } }).process?.platform === "win32"): string {
  // Windows paths cannot contain double quotes (callers avoid paths a Windows shell would expand);
  // POSIX single quotes keep $, `, \ and " literal.
  return windows ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command to print for an install at `script`. */
export function commandFor(script: string, { windows, onPath }: { windows: boolean; onPath: boolean }): string {
  if (onPath) return "planban";
  // Command Prompt and PowerShell expand %…% and $… even inside double quotes, and no one
  // quoting suits both, so such a path gets a description to follow instead of a command.
  if (windows && /[%$`!^"]/.test(script)) return `node "<Planban install folder>\\bin\\planban.mjs"`;
  return `node ${shellQuote(script, windows)}`;
}

let cached: string | undefined;

/** `planban` when it is installed as a command, otherwise `node '<this install>/bin/planban.mjs'`. */
export function planbanCommand(): string {
  if (cached) return cached;
  const node = nodeModules();
  if (!node) return (cached = "planban");
  const windows = (globalThis as { process?: { platform?: string } }).process?.platform === "win32";
  const onPath = (process.env.PATH ?? "").split(node.path.delimiter).some((directory) => {
    if (!directory) return false;
    try {
      node.fs.accessSync(node.path.join(directory, windows ? "planban.cmd" : "planban"), node.fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const script = node.path.resolve(node.path.dirname(node.url.fileURLToPath(import.meta.url)), "../../bin/planban.mjs");
  return (cached = commandFor(script, { windows, onPath }));
}
