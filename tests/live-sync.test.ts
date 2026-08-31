import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { liveRefreshDecision } from "../src/web/liveSync.js";

test("first successful live snapshot reconciles durable state instead of becoming a lossy baseline", () => {
  assert.deepEqual(
    liveRefreshDecision(null, { stateVersion: 4, boardsVersion: 2 }),
    { refreshBoards: true, refreshSelectedBoard: true },
  );
});

test("later live snapshots refresh only durable resources whose versions changed", () => {
  const previous = { stateVersion: 4, boardsVersion: 2 };
  assert.deepEqual(
    liveRefreshDecision(previous, { stateVersion: 5, boardsVersion: 2 }),
    { refreshBoards: false, refreshSelectedBoard: true },
  );
  assert.deepEqual(
    liveRefreshDecision(previous, { stateVersion: 4, boardsVersion: 3 }),
    { refreshBoards: true, refreshSelectedBoard: false },
  );
  assert.deepEqual(
    liveRefreshDecision(previous, previous),
    { refreshBoards: false, refreshSelectedBoard: false },
  );
});

test("durable app bootstrap does not await the optional live endpoint", async () => {
  const web = await readFile(new URL("../src/web/main.tsx", import.meta.url), "utf8");
  const loadStart = web.indexOf("const load = useCallback");
  const loadEnd = web.indexOf("useEffect(() => {\n    void load();", loadStart);
  assert.notEqual(loadStart, -1);
  assert.notEqual(loadEnd, -1);
  const bootstrap = web.slice(loadStart, loadEnd);
  assert.doesNotMatch(bootstrap, /api<LiveSnapshot>\("\/api\/live"/u);
  assert.match(bootstrap, /api<BoardsPayload>\("\/api\/boards\?includeArchived=true"/u);
});
