// Editing a Spec or Plan one section at a time (Spec point 20).
import assert from "node:assert/strict";
import test from "node:test";
import { docSections, editSection, sectionList } from "../src/core/docSections";

const doc = "# Spec\n\n## Purpose\n\nWhy.\n\n## Current state\n\nNow.\n\n### Detail\n\nMore.\n\n## Agent reference\n\nLinks.\n";

test("sections run to the next heading of the same or a higher level", () => {
  const list = sectionList(doc);
  assert.deepEqual(list.map((section) => [section.heading, section.level]), [["Spec", 1], ["Purpose", 2], ["Current state", 2], ["Detail", 3], ["Agent reference", 2]]);
  const current = docSections(doc).find((section) => section.heading === "Current state")!;
  assert.equal(doc.slice(current.start, current.end), "## Current state\n\nNow.\n\n### Detail\n\nMore.\n\n");
});

test("headings inside code are not sections", () => {
  assert.deepEqual(sectionList("## A\n\n```\n## not a heading\n```\n").map((section) => section.heading), ["A"]);
});

test("different sections never clash; the same section does, with what it is now", () => {
  const purpose = sectionList(doc).find((section) => section.heading === "Purpose")!.version;
  const state = sectionList(doc).find((section) => section.heading === "Current state")!.version;
  const first = editSection(doc, { heading: "Purpose", expectedVersion: purpose, text: "## Purpose\n\nWhy, sharper." });
  assert.ok(first.ok);
  // Another agent, from the same read, edits a different section: no clash.
  const second = editSection(first.markdown, { heading: "Current state", expectedVersion: state, text: "## Current state\n\nNow, updated." });
  assert.ok(second.ok);
  assert.match(second.markdown, /Why, sharper\./);
  assert.match(second.markdown, /Now, updated\./);
  // The same section from the old read: a clash, with the section as it is now.
  const third = editSection(second.markdown, { heading: "Purpose", expectedVersion: purpose, text: "## Purpose\n\nWhy, my way." });
  assert.equal(third.ok, false);
  assert.ok(!third.ok && third.reason === "changed" && third.current.text.includes("Why, sharper."));
});

test("a new section goes after a named one, or at the end; adding one that exists is a clash", () => {
  const added = editSection(doc, { heading: "Risks", expectedVersion: null, text: "## Risks\n\nNone yet.", after: "Purpose" });
  assert.ok(added.ok);
  assert.deepEqual(sectionList(added.markdown).map((section) => section.heading), ["Spec", "Purpose", "Risks", "Current state", "Detail", "Agent reference"]);
  const atEnd = editSection(doc, { heading: "Notes", expectedVersion: null, text: "## Notes\n\nLast." });
  assert.ok(atEnd.ok && atEnd.markdown.endsWith("## Notes\n\nLast.\n"));
  assert.equal(editSection(doc, { heading: "Purpose", expectedVersion: null, text: "## Purpose\n\nAgain." }).ok, false);
});
