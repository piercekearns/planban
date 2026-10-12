import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkBoardIsIndex, filesInCard, picturesInTheWay } from "../src/core/indexCheck";

test("every way of putting a picture in a document is found; pictures on the web are fine", () => {
  const markdown = [
    "![Front](renders/front.png)",
    "![Logo][logo]",
    "![Side][]",
    "[logo]: images/logo.png",
    "[side]: <images/side view.png> \"Side\"",
    "<img src=images/back.png alt=Back>",
    "<img alt='Hero' srcset=\"hero-1x.png 1x, https://example.com/hero-2x.png 2x\">",
    "<picture><source srcset=\"dark.png\"></picture>",
    "![Odd](renders/100%.png)",
    "![Inline](data:image/png;base64,AAAA)",
    "![Diagram](https://example.com/diagram.png) and ![Doc](//cdn.example.com/doc.png)",
  ].join("\n");
  const found = picturesInTheWay(markdown, "/board/items/alpha").map((picture) => `${picture.alt}=${picture.where}`);
  assert.deepEqual(found.sort(), [
    "=/board/items/alpha/dark.png",
    "Back=/board/items/alpha/images/back.png",
    "Front=/board/items/alpha/renders/front.png",
    "Hero=/board/items/alpha/hero-1x.png",
    "Inline=stored in the document",
    "Logo=/board/items/alpha/images/logo.png",
    "Odd=/board/items/alpha/renders/100%.png",
    "Side=/board/items/alpha/images/side view.png",
  ].sort());
});

test("files in a card's folder include links, which are listed and not followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-index-"));
  const folder = join(root, "items", "alpha");
  await mkdir(join(folder, "renders"), { recursive: true });
  await writeFile(join(folder, "spec.md"), "# Alpha\n");
  await writeFile(join(folder, "renders", "front.png"), "png");
  await symlink("/etc/hosts", join(folder, "hosts-link"));
  assert.deepEqual((await filesInCard(root, "alpha")).files, ["hosts-link", "renders/front.png"]);
  assert.deepEqual((await filesInCard(root, "../escape")).files, []);
  const report = await checkBoardIsIndex({ planningRoot: root, cards: [{ id: "alpha", title: "Alpha" }], docs: [{ cardId: "alpha", kind: "spec", markdown: "# Alpha\n" }] });
  assert.equal(report.clean, false);
  assert.equal(report.files, 2);
  assert.match(report.howToTidy, /labelled with its machine/);
});
