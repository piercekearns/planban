import assert from "node:assert/strict";
import { test } from "node:test";
import { urlOpener } from "../src/core/openUrl";
import { cardPath } from "../src/web/apiPaths";
import { createEmptyRoadmap, planCreateCard } from "../src/core/boardOperations";
import { checkCards } from "../online/service/convex/model/indexRules";

test("URL handlers receive command syntax as a literal URL argument on every platform", () => {
  const url = 'codex://threads/example?prompt=hello & calc.exe | echo "世界" ^ %PATH%';
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const invocation = urlOpener(url, platform);
    assert.equal(invocation.args.at(-1), url);
    assert.equal(invocation.args.filter((arg) => arg === url).length, 1);
    assert.ok(!["cmd", "powershell", "sh", "bash"].includes(invocation.command));
    assert.deepEqual(invocation.args.slice(0, -1), platform === "win32" ? ["url.dll,FileProtocolHandler"] : []);
  }
});

test("current and history card actions retain their board despite imported URL syntax", () => {
  const ids = ["../../victim/cards/alpha", "..\\..\\victim", "%2e%2e%2fother", "alpha?board=other", "alpha#fragment", "alpha%id", "ordinary-card"];
  for (const id of ids) {
    for (const version of [undefined, 3]) {
      for (const suffix of ["", "/move", "/docs/spec", "/docs/plan/restore", "/codex-thread/sync", "/restore"]) {
        const url = new URL(cardPath("intended-board", id, suffix, version), "http://127.0.0.1:4317");
        const prefix = `/api/boards/intended-board${version === undefined ? "" : "/history/3"}/cards/`;
        assert.ok(url.pathname.startsWith(prefix), url.pathname);
        assert.equal(url.search, "");
        assert.equal(url.hash, "");
        assert.equal(decodeURIComponent(url.pathname.slice(prefix.length).split("/")[0]!), id);
      }
    }
  }
  for (const id of [".", ".."]) assert.throws(() => cardPath("intended-board", id), /unsafe id/);
});

test("online current and historical roadmap validation refuses unsafe card identities", () => {
  const now = "2026-10-12T00:00:00.000Z";
  const base = createEmptyRoadmap({ repoId: "intended-board", title: "Disposable", now });
  const valid = planCreateCard(base, { title: "Ordinary", status: "pending" }, { now }).roadmap;
  checkCards(valid);
  for (const id of ["../../victim/cards/alpha", ".", "..", "alpha/other", "alpha\\other", "%2e%2e", "alpha?x", "alpha#x"]) {
    const bad = { ...valid, roadmapItems: valid.roadmapItems.map((card) => ({ ...card, id })) };
    assert.throws(() => checkCards(bad), /plain card ids/);
    assert.throws(() => checkCards(bad, bad), /plain card ids/, "unchanged historical ids are checked too");
  }
});
