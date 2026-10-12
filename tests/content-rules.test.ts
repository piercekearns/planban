import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIndexCard, checkIndexDocument, embeddedFileIn, MAX_DOCUMENT_BYTES } from "../src/core/contentRules";

const pngBase64 = Buffer.alloc(3000, 7).toString("base64");

test("Online Boards refuse embedded files in any form, and say how to refer to them instead", () => {
  assert.match(embeddedFileIn(`![shot](data:image/png;base64,${pngBase64.slice(0, 400)})`)!, /data: address/);
  assert.match(embeddedFileIn(`<img src="data:image/jpeg;base64,${pngBase64.slice(0, 400)}">`)!, /data: address/);
  // Forms that slip past a simple pattern: no type, not base64, or base64 wrapped over lines.
  assert.match(embeddedFileIn(`data:;base64,${pngBase64.slice(0, 400)}`)!, /data: address/);
  assert.match(embeddedFileIn(`data:text/plain,${"hello%20file%0A".repeat(40)}`)!, /data: address/);
  assert.match(embeddedFileIn(pngBase64.match(/.{1,76}/g)!.join("\n"))!, /base64/);
  assert.match(embeddedFileIn(`> ${pngBase64.match(/.{1,64}/g)!.join("\n> ")}`)!, /base64/);
  assert.match(embeddedFileIn(pngBase64)!, /base64/);
  assert.match(embeddedFileIn("PK\u0003\u0004 zipped")!, /binary/);
  assert.throws(() => checkIndexDocument(`Renders:\n\n![front](data:image/png;base64,${pngBase64})`, "alpha", "spec"),
    /Not saved: the Spec of card alpha contains (an embedded file|a picture stored in the text).*GitHub link.*local path labelled with its machine/s);
  assert.throws(() => checkIndexCard({ id: "alpha", summary: `See ${pngBase64}` }), /card alpha contains an encoded file/);
});

test("ordinary planning text is never mistaken for a file", () => {
  const prose = [
    "# Plan\n\nSee https://github.com/pjk-hq/northfold/blob/main/renders/front.png and Mac mini: ~/Projects/northfold/renders/front.png.",
    "| a | b |\n|---|---|\n| 1 | 2 |\n\tindented code\r\n",
    `Commit ${"a3f9".repeat(10)}; hash sha256-${"Zm9v".repeat(40)}`,
    "```ts\nconst x = `data:${type};base64,` + body; // code that mentions data URIs is fine\n```",
    "Reject input such as `data:image/png;base64,AAAA` in the upload validator.",
    "Short examples like data:text/plain,hello%20file are prose, not files.",
  ].join("\n\n");
  assert.equal(embeddedFileIn(prose), null);
  checkIndexDocument(prose, "alpha", "plan");
  checkIndexCard({ id: "alpha", title: "Choose the supplier", summary: prose.slice(0, 500) });
});

test("documents and cards have size limits above any real board's", () => {
  checkIndexDocument("word ".repeat(120 * 1024), "alpha", "plan");
  assert.throws(() => checkIndexDocument("word ".repeat(MAX_DOCUMENT_BYTES / 4), "alpha", "plan"), /limit is 1024 KB.*link to it/s);
  checkIndexCard({ id: "alpha", summary: "y ".repeat(30 * 1024) });
  assert.throws(() => checkIndexCard({ id: "alpha", summary: "y ".repeat(70 * 1024) }), /card alpha is .* KB; the limit is 128 KB/);
});

test("numbers standing in for bytes, and oversized details, are refused wherever they hide", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  assert.throws(() => checkIndexCard({ id: "alpha", metadata: { logo: Array.from({ length: 4000 }, (_, i) => i % 256) } }), /long lists? of numbers/);
  checkIndexCard({ id: "alpha", metadata: { scores: [1, 2, 3] } });
  assert.throws(() => checkIndexValue({ summary: `data:image/png;base64,${pngBase64}` }, "a history entry", 64 * 1024), /a history entry contains an embedded file/);
});

test("history keeps its text when the files embedded in it are taken out", async () => {
  const { withoutEmbeddedFiles } = await import("../src/core/contentRules");
  const wrapped = pngBase64.match(/.{1,76}/g)!.join("\n");
  const cleaned = withoutEmbeddedFiles(`Before\n![x](data:image/png;base64,${pngBase64})\n${wrapped}\nAfter, see \`data:image/png;base64,AAAA\``, "[kept on the Mac]");
  assert.equal(embeddedFileIn(cleaned), null);
  assert.match(cleaned, /^Before\n!\[x\]\(\[kept on the Mac\]\)\n\[kept on the Mac\]\nAfter, see `\[kept on the Mac\]`$/);
});

import { randomBytes } from "node:crypto";

test("a file split into short pieces, interleaved with prose or hidden in keys still adds up", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  const file = randomBytes(1825).toString("base64");
  const pieces = file.match(/.{1,200}/g)!;
  assert.match(embeddedFileIn(pieces.map((piece) => `data:text/plain;base64,${piece}`).join("\n"))!, /data: addresses/);
  assert.match(embeddedFileIn(file.match(/.{1,50}/g)!.map((piece, index) => `Step ${index}: ${piece} done.`).join("\n"))!, /base64/);
  assert.throws(() => checkIndexValue({ [`data:text/plain;base64,${file.slice(0, 439)}`]: "x" }, "card alpha", 128 * 1024), /card alpha contains an embedded file/);
  assert.throws(() => checkIndexCard({ id: "alpha", metadata: Object.fromEntries(pieces.map((piece, index) => [`k${index}`, `data:,${piece}`])) }), /embedded file/);
});

test("real planning text with addresses, hashes, ids and paths is not mistaken for a file", () => {
  const hashes = Array.from({ length: 40 }, () => randomBytes(32).toString("hex")).join("\n");
  const uuids = Array.from({ length: 60 }, () => `PROD-${crypto.randomUUID()}`).join(", ");
  const paths = Array.from({ length: 30 }, (_, index) => `codex/visualizations/2026/09/30/${crypto.randomUUID()}/revival-audit/source/${index}.md`).join("\n");
  const longUrl = `https://example.com/report?state=${randomBytes(1600).toString("base64url")}`;
  const text = ["```", hashes, "```", uuids, paths, `See ${longUrl}`, "SHA256115dbd3f4be227900acefefa17e9b98687cfd2fb6416d6db8ed604b8f7e007b4 and MA05ownerUsage/absentRetry/phone/provider"].join("\n\n");
  assert.equal(embeddedFileIn(text), null);
});

test("short pieces, plain repetitive payloads, nested byte lists and tiny pictures are all refused; examples in code are not", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  const random = randomBytes(3000).toString("base64");
  assert.match(embeddedFileIn(random.match(/.{1,32}/g)!.join(" and "))!, /base64/);
  const plain = Buffer.alloc(24 * 1024, 5).toString("base64");
  assert.match(embeddedFileIn(plain.match(/.{1,48}/g)!.join("\n\n"))!, /base64/);
  assert.throws(() => checkIndexCard({ id: "alpha", metadata: { a: Array(512).fill(7), b: { c: Array(512).fill(9) }, d: [Array(100).fill(1)] } }), /long lists of numbers/);
  const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  assert.match(embeddedFileIn(`![pixel](data:image/gif;base64,${gif})`)!, /picture stored in the text/);
  assert.match(embeddedFileIn(`<img alt="x" src="data:image/gif;base64,${gif}">`)!, /picture stored in the text/);
  assert.equal(embeddedFileIn(`Use \`![pixel](data:image/gif;base64,${gif})\` as the test image.`), null);
  assert.equal(embeddedFileIn(`\`\`\`md\n![pixel](data:image/gif;base64,${gif})\n\`\`\``), null);
  checkIndexValue({ scores: [1, 2, 3], weights: [[0.5, 0.25]] }, "card alpha", 128 * 1024);
});

test("standard encoders are refused: wrapped hex, base64url, numbers in text, and pictures in any case", () => {
  const bytes = randomBytes(4096);
  assert.match(embeddedFileIn(bytes.toString("hex").match(/.{1,60}/g)!.join("\n"))!, /encoded file/);
  assert.match(embeddedFileIn(Buffer.alloc(4096, 255).toString("base64url"))!, /base64/);
  assert.match(embeddedFileIn(`const logo = [${[...bytes].join(", ")}];`)!, /encoded file/);
  assert.match(embeddedFileIn(`unsigned char logo[] = { ${[...bytes].map((b) => `0x${b.toString(16)}`).join(", ")} };`)!, /encoded file/);
  const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  assert.match(embeddedFileIn(`![pixel](DATA:image/gif;base64,${gif})`)!, /picture stored/);
  assert.match(embeddedFileIn(`[pixel]: Data:image/gif;base64,${gif}`)!, /picture stored/);
});

test("hash lists, code examples and ordinary numbers stay fine", () => {
  const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  const text = [
    Array.from({ length: 40 }, () => randomBytes(32).toString("hex")).join("\n"),
    "These are the release checksums; the commits follow.",
    "Commits: " + Array.from({ length: 60 }, () => randomBytes(20).toString("hex")).join(" and "),
    `~~~md\n![pixel](data:image/gif;base64,${gif})\n~~~`,
    "````\n```\n![pixel](data:image/gif;base64," + gif + ")\n```\n````",
    "Use ``![pixel](data:image/gif;base64," + gif + ")`` in the test.",
    "Sizes: 1, 2, 3, 5, 8, 13, 21, 34 and 55.",
  ].join("\n\n");
  assert.equal(embeddedFileIn(text), null);
});

test("a card may hold many single-hash fields, but not a file split into them", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  checkIndexValue({ id: "alpha", metadata: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`asset${i}Sha256`, randomBytes(32).toString("hex")])) }, "card alpha", 128 * 1024);
  const file = randomBytes(4096).toString("hex").match(/.{64}/g)!;
  assert.throws(() => checkIndexValue({ id: "alpha", metadata: Object.fromEntries(file.map((piece, i) => [`p${i}`, piece])) }, "card alpha", 128 * 1024), /encoded file/);
});

test("every common way an encoder writes a file is refused, at any wrapping", () => {
  const f = randomBytes(4096);
  const ff = Buffer.alloc(4096, 255);
  const variants: Record<string, string> = {
    "base64 at 48": f.toString("base64").match(/.{1,48}/g)!.join("\n"),
    "repetitive base64 with blank lines": ff.toString("base64").match(/.{1,48}/g)!.join("\n\n"),
    "repetitive base64url at 32": ff.toString("base64url").match(/.{1,32}/g)!.join("\n"),
    "hex at 16": f.toString("hex").match(/.{1,16}/g)!.join("\n"),
    "hex at 32": f.toString("hex").match(/.{1,32}/g)!.join("\n"),
    "hex at 64": f.toString("hex").match(/.{1,64}/g)!.join("\n"),
    "xxd's default dump": f.toString("hex").match(/.{1,32}/g)!.map((line, i) => `${(i * 16).toString(16).padStart(8, "0")}: ${line.match(/.{1,4}/g)!.join(" ")}  ................`).join("\n"),
    "byte rows of 16": "[\n" + [...f].map(String).join(",").match(/(?:\d+,?){1,16}/g)!.join("\n") + "\n]",
    "quoted hex bytes": JSON.stringify([...f].map((b) => `0x${b.toString(16)}`)),
    "a C array": [...f].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ").match(/(?:0x..,? ?){1,12}/g)!.join("\n"),
    "base64 between words": f.toString("base64").match(/.{1,50}/g)!.map((piece, i) => `Step ${i}: ${piece} done.`).join("\n"),
  };
  for (const [name, text] of Object.entries(variants)) assert.match(embeddedFileIn(text) ?? "missed", /encoded file/, name);
});
