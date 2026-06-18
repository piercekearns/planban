import assert from "node:assert/strict";
import test from "node:test";
import { boardViewPreferencesKey, normalizeBoardViewPreferences } from "../src/web/boardPreferences";

test("defaults the complete column cards to hidden for fresh board views", () => {
  const preferences = normalizeBoardViewPreferences();

  assert.deepEqual(preferences.collapsed, {});
  assert.equal(preferences.hiddenCards.complete, true);
  assert.equal(preferences.showArchived, false);
});

test("preserves explicit complete column card visibility preferences", () => {
  const preferences = normalizeBoardViewPreferences({
    hiddenCards: {
      complete: false,
      pending: true,
    },
    showArchived: true,
  });

  assert.equal(preferences.hiddenCards.complete, false);
  assert.equal(preferences.hiddenCards.pending, true);
  assert.equal(preferences.showArchived, true);
});

test("uses a stable board view preference key per repo id", () => {
  assert.equal(boardViewPreferencesKey("planban"), "planban:board-view:planban:v1");
});
