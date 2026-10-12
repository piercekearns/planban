/** Platform URL handlers receive the URL as one argument, never shell source. */
export function urlOpener(url: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
    : { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}
