import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkBoardIsIndex, filesInCard, picturesInTheWay } from "../src/core/indexCheck";
import { embeddedFileIn, INDEX_NOT_STORAGE } from "../src/core/contentRules";

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
    "![photo]",
    "[photo]: /tmp/photo.png",
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
    "photo=/tmp/photo.png",
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

test("a card folder that is a link, nested metadata and board details are all checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-index-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "planban-elsewhere-"));
  await writeFile(join(elsewhere, "spec.md"), "# Elsewhere\n");
  await mkdir(join(root, "items"), { recursive: true });
  await symlink(elsewhere, join(root, "items", "linked"));
  assert.deepEqual((await filesInCard(root, "linked")).files, ["(this card's folder is a link to another folder)"]);
  const payload = `data:text/plain;base64,${"QUJD".repeat(80)}`;
  const report = await checkBoardIsIndex({
    planningRoot: root,
    cards: [{ id: "beta", title: "Beta", metadata: { deep: { note: payload } } }],
    docs: [],
    details: { project: { title: "Board", description: payload } },
  });
  assert.equal(report.clean, false);
  assert.match(report.cards[0]!.problems.join(" "), /embedded file/);
  assert.match(report.boardProblems.join(" "), /board's details contains an embedded file/);
});

test("pictures shown as examples in code are not in the way", () => {
  const markdown = "Use `![photo](images/photo.png)` like this:\n\n```md\n![photo](images/photo.png)\n```\n\n~~~\n![x](x.png)\n~~~\n";
  assert.deepEqual(picturesInTheWay(markdown, "/board/items/alpha"), []);
});

test("system files and Planban's own save files never freeze a card; an empty folder does; the advice names move-files-out", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-index-"));
  const folder = join(root, "items", "alpha");
  await mkdir(join(folder, "renders"), { recursive: true });
  await writeFile(join(folder, ".DS_Store"), "x");
  await writeFile(join(folder, ".spec.md.123.4.0f5a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b.tmp"), "saving");
  assert.deepEqual((await filesInCard(root, "alpha")).files, ["renders/"]);
  const report = await checkBoardIsIndex({ planningRoot: root, cards: [{ id: "alpha", title: "Alpha" }], docs: [] });
  assert.match(report.howToTidy, /planban move-files-out <card> --to <folder>/);
  assert.match(embeddedFileIn("x") === null ? INDEX_NOT_STORAGE : "", /^Planban boards hold text only/);
});
