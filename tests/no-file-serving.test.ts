// Owner decision 18: Planban never serves what it stores as a file. No raw or
// attachment-style endpoints, no download headers, and no content types other
// than Planban's own (JSON for data, the invite page's HTML). This test reads
// the code that answers requests, so a new route cannot quietly add one.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const read = (path: string) => readFile(join(process.cwd(), path), "utf8");

test("the online service answers only with Planban's own content types, never as a file", async () => {
  const http = await read("online/service/convex/http.ts");
  const mcp = await read("online/service/convex/model/mcp.ts");
  for (const [name, source] of [["http.ts", http], ["mcp.ts", mcp]] as const) {
    assert.doesNotMatch(source, /Content-Disposition/i, `${name}: no download headers`);
    assert.doesNotMatch(source, /model\/blobs|streamParts/, `${name}: the stored-file code is not routed`);
    const types = [...source.matchAll(/"Content-Type":\s*"([^"]+)"/g)].map((match) => match[1]!.split(";")[0]!.trim());
    for (const type of types) assert.ok(["application/json", "text/html"].includes(type), `${name}: unexpected content type ${type}`);
  }
  // HTML is only the invite page, which Planban writes itself and escapes.
  assert.equal([...http.matchAll(/text\/html/g)].length, 1);
  assert.match(http, /const invitePage = httpAction/);
  // No route serves attachments.
  assert.match(http, /rest\[0\] === "attachments"\) return json\(\{ error: \{ code: "not_found"/);
});

test("the local board server serves the board page and JSON, never stored files", async () => {
  for (const name of await readdir(join(process.cwd(), "src/server"))) {
    const source = await read(join("src/server", name));
    assert.doesNotMatch(source, /res\.download\(|res\.attachment\(|sendFile\(|Content-Disposition/i, `${name}: no file downloads`);
    for (const match of source.matchAll(/express\.static\(([^)]*)\)/g)) assert.equal(match[1], "DIST_WEB_ROOT", `${name}: only the built board page is served as files`);
  }
});
