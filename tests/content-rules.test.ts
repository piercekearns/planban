import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIndexCard, checkIndexDocument, embeddedFileIn, MAX_DOCUMENT_BYTES } from "../src/core/contentRules";

const pngBase64 = Buffer.alloc(3000, 7).toString("base64");

test("Online Boards refuse embedded files in any form, and say how to refer to them instead", () => {
  assert.match(embeddedFileIn(`![shot](data:image/png;base64,${pngBase64.slice(0, 40)})`)!, /data: address/);
  assert.match(embeddedFileIn(`<img src="data:image/jpeg;base64,AAAA">`)!, /data: address/);
  assert.match(embeddedFileIn(pngBase64)!, /base64/);
  assert.match(embeddedFileIn("PK\u0003\u0004 zipped")!, /binary/);
  assert.throws(() => checkIndexDocument(`Renders:\n\n![front](data:image/png;base64,${pngBase64})`, "alpha", "spec"),
    /Not saved: the Spec of card alpha contains an embedded file.*GitHub link.*local path labelled with its machine/s);
  assert.throws(() => checkIndexCard({ id: "alpha", summary: `See ${pngBase64}` }), /card alpha contains an encoded file/);
});

test("ordinary planning text is never mistaken for a file", () => {
  const prose = [
    "# Plan\n\nSee https://github.com/pjk-hq/northfold/blob/main/renders/front.png and Mac mini: ~/Projects/northfold/renders/front.png.",
    "| a | b |\n|---|---|\n| 1 | 2 |\n\tindented code\r\n",
    `Commit ${"a3f9".repeat(10)}; hash sha256-${"Zm9v".repeat(40)}`,
    "```ts\nconst x = `data:${type};base64,` + body; // code that mentions data URIs is fine\n```",
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
