// The brand files the service serves and embeds: filled icons for AI apps, favicons and the wordmark.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { BRAND_PATHS, FAVICON_DATA_URI, FAVICON_ICO_BASE64, FAVICON_SVG, ICON_DARK_PNG_BASE64, ICON_LIGHT_PNG_BASE64, WORDMARK_BLACK_DATA_URI } from "../online/service/convex/model/brandAssets";
import { consentPage } from "../online/service/convex/model/oauthConsentPage";

const bytes = (base64: string) => Buffer.from(base64, "base64");
const pngSize = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];
const PNG = "89504e470d0a1a0a";

test("the icons are filled 512-pixel squares, one for light interfaces and one for dark", () => {
  for (const [name, base64, corner] of [["light", ICON_LIGHT_PNG_BASE64, "white"], ["dark", ICON_DARK_PNG_BASE64, "black"]] as const) {
    const png = bytes(base64);
    assert.equal(png.subarray(0, 8).toString("hex"), PNG, name);
    assert.deepEqual(pngSize(png), [512, 512], name);
    assert.ok(png.length > 2000 && png.length < 100_000, `${name} is a real image of sensible size (${corner} tile)`);
  }
  assert.notEqual(ICON_LIGHT_PNG_BASE64, ICON_DARK_PNG_BASE64);
});

test("the favicon follows the browser's light or dark setting and carries no script", () => {
  assert.match(FAVICON_SVG, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(FAVICON_SVG, /@media \(prefers-color-scheme:dark\)\{\.m\{fill:#fff\}\}/);
  assert.doesNotMatch(FAVICON_SVG, /<script|on\w+=|href=|xlink/i);
  assert.equal(Buffer.from(FAVICON_DATA_URI.replace("data:image/svg+xml;base64,", ""), "base64").toString(), FAVICON_SVG);
  const ico = bytes(FAVICON_ICO_BASE64);
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 2], "an icon file with two images");
  for (const entry of [0, 1]) {
    const at = 6 + entry * 16, size = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
    const png = ico.subarray(offset, offset + size);
    assert.equal(png.subarray(0, 8).toString("hex"), PNG);
    assert.deepEqual(pngSize(png), [[32, 32], [48, 48]][entry]);
  }
});

test("both MCP servers point AI apps at the themed icons the service serves", async () => {
  for (const file of ["online/service/convex/model/mcp.ts", "plugins/planban/mcp/server.mjs"]) {
    const source = await readFile(file, "utf8");
    for (const [path, theme] of [[BRAND_PATHS.iconLight, "light"], [BRAND_PATHS.iconDark, "dark"]]) {
      assert.ok(source.includes(`{ src: "https://app.planban.ai${path}", mimeType: "image/png", sizes: ["512x512"], theme: "${theme}" }`), `${file}: ${theme} icon`);
    }
  }
});

test("the sign-in page shows the real wordmark and the favicon, both inline", () => {
  const html = consentPage({ nonce: "n", frontend: "https://fixture.clerk.example", key: "pk_test_fixture", returnTo: "https://planban.example/oauth/consent?request=pbe_x", secret: "pbe_x", csrf: "pbs_x", clientName: "Planban CLI", clientId: "planban-cli", permission: "Use your full access", machine: true, offline: false });
  assert.ok(html.includes(`<img src="${WORDMARK_BLACK_DATA_URI}" alt="Planban">`));
  assert.ok(html.includes(`<link rel="icon" href="${FAVICON_DATA_URI}">`));
  assert.match(WORDMARK_BLACK_DATA_URI, /^data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(Buffer.from(WORDMARK_BLACK_DATA_URI.split(",")[1]!, "base64").toString(), /<script|on\w+=/i);
});

test("the invitation page shows the wordmark and favicon and allows only inline images", async () => {
  const http = await readFile("online/service/convex/http.ts", "utf8");
  const page = http.slice(http.indexOf("const invitePageResponse"), http.indexOf("export function atServiceOnly"));
  assert.match(page, /<link rel="icon" href="\$\{FAVICON_DATA_URI\}">/);
  assert.match(page, /<img src="\$\{WORDMARK_BLACK_DATA_URI\}"/);
  assert.match(page, /default-src 'none'; img-src data:;/);
});

test("dialogs draw no line above their buttons or under their last section", async () => {
  const css = await readFile("src/web/styles.css", "utf8");
  const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[2] ?? "";
  for (const selector of [".tutorial-footer", ".work-item-search-footer", ".group-placement-actions", ".feedback-actions"]) {
    assert.ok(rule(selector).length, `${selector} exists`);
    assert.doesNotMatch(rule(selector), /border-top/, `${selector} has no line above it`);
  }
  assert.match(css, /\.online-board-section:not\(:has\(~ \.online-board-section\)\) \{ border-bottom: 0; \}/);
  const modal = await readFile("src/web/onlineBoard.tsx", "utf8");
  assert.doesNotMatch(modal, /<div style=\{\{ height: 6 \}\} \/>/, "no spacer pushes the last section off the end");
});
