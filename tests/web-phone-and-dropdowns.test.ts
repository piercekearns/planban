// Planban 2.0 phase 3, checked in the page source: one Planban dropdown
// everywhere, phones without dragging, and viewers without edit controls.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path: string) => readFile(new URL(`../src/web/${path}`, import.meta.url), "utf8");

test("the page uses the one Planban dropdown, never the browser's own, except as the phone's picker", async () => {
  for (const file of ["main.tsx", "onlineBoard.tsx"]) assert.doesNotMatch(await read(file), /<select\b/u, file);
  const dropdown = await read("Dropdown.tsx");
  assert.match(dropdown, /\(pointer: coarse\)/u, "touch screens get the phone's picker");
  assert.match(dropdown, /role="listbox"/u);
  assert.match(dropdown, /aria-activedescendant/u);
  assert.match(dropdown, /aria-selected=\{option\.value === value\}/u);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Enter"]) assert.match(dropdown, new RegExp(`"${key}"`, "u"), key);
  assert.match(dropdown, /event\.key === "Tab"\) \{\s*setOpen\(false\);\s*triggerRef\.current\?\.focus\(\);/u, "Tab carries on from the dropdown's button");
  assert.match(dropdown, /if \(open && place\) document\.getElementById\(`\$\{id\}-option-\$\{active\}`\)\?\.scrollIntoView\(\{ block: "nearest" \}\)/u, "the active choice stays in view, from the first opening");
  assert.match(dropdown, /listRef\.current\?\.contains\(event\.target as Node\)\) return;/u, "scrolling the menu doesn't close it");
  const styles = await read("styles.css");
  assert.match(styles, /\.pb-dropdown-trigger\s*\{[^}]*gap:\s*6px;/su, "the arrow sits 6 px after the text");
  assert.match(styles, /\.pb-dropdown-trigger\s*\{[^}]*min-height:\s*30px;/su, "as tall as the buttons beside it");
});

test("phones scroll one list, move cards without dragging, and keep Save above the keyboard", async () => {
  const web = await read("main.tsx");
  // One stable argument: a changing argument count leaves React holding the old sensors.
  assert.match(web, /useSensors\(phone \|\| viewOnly \? undefined : pointerSensor\)/u);
  assert.doesNotMatch(web, /useSensors\(\.\.\./u);
  assert.match(web, /function PhoneStatusTabs/u);
  assert.match(web, /useKeyboardInset\(\)/u);
  const styles = await read("styles.css");
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.editor-actions\s*\{[^}]*bottom:\s*var\(--keyboard-inset, 0px\)/su);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.modal-backdrop > \[role="dialog"\]\s*\{[^}]*height:\s*100%/su, "dialogs are full-height sheets");
});

test("a conflicting save keeps the person's text, and a viewer gets no edit controls", async () => {
  const web = await read("main.tsx");
  const save = web.slice(web.indexOf("async function saveDoc()"), web.indexOf("return (", web.indexOf("async function saveDoc()")));
  assert.match(save, /status === 409/u);
  assert.doesNotMatch(save, /setDraft\(payload\.markdown\);\s*\}\s*finally/u, "a failed save never replaces the draft");
  assert.match(web, /changed this \$\{docKindLabel\(activeTab\)\} while you were editing\./u);
  // Saving over the other version is only possible once the person has opened it, and each new conflict asks again.
  assert.match(web, /setConflict\(\{ theirs, who: await latestDocAuthor\(\), showing: false, seen: false \}\)/u);
  assert.match(web, /\(conflict !== null && !conflict\.seen\)/u);
  assert.match(web, /showing: !conflict\.showing, seen: true/u);
  // Viewers get no order controls in a Group either.
  assert.match(web, /readOnly=\{viewOnly\}/u);
  assert.match(web, /const viewOnly = state\.hosted\?\.role === "viewer";/u);
  assert.match(web, /readOnly=\{isPreviewing \|\| viewOnly\}/u);
});
