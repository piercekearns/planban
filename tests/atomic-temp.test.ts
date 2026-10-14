import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { isAtomicWriteTemp } from "../src/core/persistence";

test("only Planban's own half-written files count as temporary, never a document that merely ends in .tmp", () => {
  assert.equal(isAtomicWriteTemp(`.STALE-COPY.json.3882.1791943048726.${randomUUID()}.tmp`), true);
  assert.equal(isAtomicWriteTemp(`.roadmap.json.1.2.${randomUUID()}.tmp`), true);
  for (const name of [".notes.tmp", ".draft.tmp", "spec.md", ".roadmap.json.12.34.tmp", `roadmap.json.1.2.${randomUUID()}.tmp`, `.x.1.2.${randomUUID()}.tmp.md`]) {
    assert.equal(isAtomicWriteTemp(name), false, name);
  }
});
