const WINDOWS_COMMAND_SHIMS = new Set(["codex", "codex.cmd", "npm", "npm.cmd", "npx", "npx.cmd"]);

export function platformInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const normalized = command.toLowerCase().split(/[\\/]/u).at(-1);
  if (platform === "win32" && WINDOWS_COMMAND_SHIMS.has(normalized)) {
    return {
      command: options.comspec || process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}
