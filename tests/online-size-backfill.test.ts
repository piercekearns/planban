import assert from "node:assert/strict";
import { test } from "node:test";
import { backfillBoard } from "../online/service/convex/limits";
import { addStored } from "../online/service/convex/model/limits";

test("size backfill restarts after an interleaved write instead of losing its bytes", async () => {
  const at = { boardId: "test-board", generation: 1 };
  let size = { _id: "size", ...at, bytes: 10, epoch: 1 };
  let markdown = "0123456789";
  const scheduled: any[] = [];
  const ctx: any = {
    db: {
      query(table: string) {
        return {
          withIndex() { return this; },
          async unique() { return { ...size }; },
          async paginate() {
            return { page: table === "docs" ? [{ markdown }] : [], isDone: true, continueCursor: "" };
          },
        };
      },
      async patch(_id: string, fields: object) { size = { ...size, ...fields }; },
    },
    scheduler: { async runAfter(_delay: number, _fn: unknown, args: unknown) { scheduled.push(args); } },
  };
  // Invoke Convex's registered handler, interleaving transactions at a batch boundary.
  const run = (backfillBoard as any)._handler;
  await run(ctx, { ...at, table: 1, cursor: null, total: 0, epoch: null });
  const measured = scheduled.shift();
  assert.equal(measured.total, 10);
  markdown += "x".repeat(100);
  await addStored(ctx, at, 100);
  assert.equal(size.bytes, 110);
  assert.equal(size.epoch, 2);
  await run(ctx, measured);
  assert.equal(size.bytes, 110, "the old measurement cannot replace the new total");
  assert.equal(scheduled[0].table, 0, "measurement restarts from the first table");
  assert.equal(scheduled[0].epoch, null);
  while (scheduled.length) await run(ctx, scheduled.shift());
  assert.equal(size.bytes, 110, "the restarted measurement includes the concurrent write");
  assert.equal(size.epoch, 3);
  // Even the final batch must validate its epoch before installing a total.
  await run(ctx, { ...at, table: 5, cursor: null, total: 10, epoch: 1 });
  assert.equal(size.bytes, 110);
  assert.equal(scheduled[0].table, 0);
});
