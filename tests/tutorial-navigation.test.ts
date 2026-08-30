import assert from "node:assert/strict";
import test from "node:test";

import { tutorialExitRepoId, tutorialPath } from "../src/web/tutorialNavigation.js";

test("reopened tutorial carries its originating board through Skip and Finish", () => {
  const originRepoId = "example-project";
  const path = tutorialPath("first-run", originRepoId);

  assert.equal(path, "/tutorial?mode=first-run&returnTo=example-project");
  assert.equal(tutorialExitRepoId(new URL(path, "http://localhost").search, "planban-demo"), originRepoId);
});

test("first-run tutorial without an origin keeps the demo-board destination", () => {
  const path = tutorialPath("first-run");

  assert.equal(path, "/tutorial?mode=first-run");
  assert.equal(tutorialExitRepoId(new URL(path, "http://localhost").search, "planban-demo"), "planban-demo");
});

test("tutorial return board ids are URL encoded", () => {
  const path = tutorialPath("whats-new", "board with/slash");

  assert.equal(path, "/tutorial?mode=whats-new&returnTo=board+with%2Fslash");
  assert.equal(tutorialExitRepoId(new URL(path, "http://localhost").search, "planban-demo"), "board with/slash");
});
