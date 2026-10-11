import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const LOCK_DIR = ".planban-write.lock";
const IDEMPOTENCY_FILE = ".idempotency.json";
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 2 * 60 * 1000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_RECORDS = 500;

const heldLocks = new AsyncLocalStorage<Set<string>>();

interface IdempotencyRecord {
  key: string;
  scope: string;
  fingerprint: string;
  createdAt: string;
  completedAt?: string | undefined;
  response?: unknown;
}

interface IdempotencyStore {
  version: 1;
  records: IdempotencyRecord[];
}

export class PlanbanIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanIdempotencyConflictError";
  }
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fsyncDirectory(path: string) {
  try {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort across platforms and filesystems.
  }
}

export async function atomicWriteFile(path: string, contents: string | Uint8Array) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  let handle = await open(tempPath, "w");
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await rename(tempPath, path);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function appendLineDurably(path: string, line: string) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/*
 * Board write lock.
 *
 * Processes of this version take turns through a queue of uniquely named
 * ticket files (Lamport's bakery algorithm on the file system): a waiter
 * announces that it is choosing, takes the next number, and enters when no
 * live process is still choosing and no live ticket is ahead of it. Every
 * file has its own unique name and is only ever removed by its owner or once
 * its owner's process has gone, so recovering from a killed process can
 * never remove someone else's newer file. A live process is never pushed out,
 * however long it holds the lock.
 *
 * The queue's winner also takes the original single lock directory, with the
 * original rules, so older Planban versions writing the same board are still
 * excluded. Only the queue's winner touches that directory, so processes of
 * this version never race each other for it.
 */
const QUEUE_DIR = ".planban-write.queue";

interface LockOwner {
  pid?: number;
  token?: string;
  /** Written by the queue's winner: removable at once if its process has gone. */
  queue?: boolean;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function processIsAlive(pid: unknown): boolean | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

interface QueueEntry {
  name: string;
  kind: "choosing" | "ticket";
  number: number;
  id: string;
}

function parseEntry(name: string): QueueEntry | null {
  const choosing = /^choosing-([a-f0-9-]{36})\.json$/.exec(name);
  if (choosing) return { name, kind: "choosing", number: 0, id: choosing[1]! };
  const ticket = /^ticket-(\d{12})-([a-f0-9-]{36})\.json$/.exec(name);
  if (ticket) return { name, kind: "ticket", number: Number(ticket[1]), id: ticket[2]! };
  return null;
}

/** Live entries of the queue; entries of processes that have gone are removed (their names are unique). */
async function liveEntries(queue: string): Promise<QueueEntry[]> {
  const live: QueueEntry[] = [];
  for (const name of await readdir(queue).catch(() => [] as string[])) {
    const entry = parseEntry(name);
    if (!entry) continue;
    const owner = await readJsonFile<LockOwner>(join(queue, name));
    // An unreadable entry is still being written, unless it has stayed
    // unreadable for ten seconds (its writer died mid-write).
    const abandoned = !owner && Date.now() - ((await stat(join(queue, name)).catch(() => null))?.mtimeMs ?? Date.now()) > 10_000;
    if (abandoned || (owner && processIsAlive(owner.pid) === false)) {
      await rm(join(queue, name), { force: true });
      continue;
    }
    live.push(entry);
  }
  return live;
}

const ahead = (a: QueueEntry, b: QueueEntry) => a.number < b.number || (a.number === b.number && a.id < b.id);

async function enterQueue(queue: string, id: string): Promise<string> {
  await mkdir(queue, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, token: id }) + "\n";
  const choosing = join(queue, `choosing-${id}.json`);
  let ticket: string | null = null;
  try {
    await writeFile(choosing, owner, { flag: "wx" });
    const highest = Math.max(0, ...(await liveEntries(queue)).filter((entry) => entry.kind === "ticket").map((entry) => entry.number));
    const mine: QueueEntry = { name: `ticket-${String(highest + 1).padStart(12, "0")}-${id}.json`, kind: "ticket", number: highest + 1, id };
    ticket = join(queue, mine.name);
    await writeFile(ticket, owner, { flag: "wx" });
    await rm(choosing, { force: true });
    for (;;) {
      const entries = await liveEntries(queue);
      const busy = entries.some((entry) => entry.id !== id && (entry.kind === "choosing" || ahead(entry, mine)));
      if (!busy) return ticket;
      await sleep(LOCK_RETRY_MS);
    }
  } catch (error) {
    // A failure part-way must not leave this live process's entries blocking others.
    await rm(choosing, { force: true }).catch(() => undefined);
    if (ticket) await rm(ticket, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The original lock directory, for older Planban versions writing the same board. */
async function takeLegacyLock(lockPath: string, token: string) {
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, queue: true, createdAt: new Date().toISOString() }) + "\n", "utf8");
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info) {
        const owner = await readJsonFile<LockOwner>(join(lockPath, "owner.json"));
        // Left by a queue winner whose process has gone: no other process of
        // this version can be using it, so it is removed at once.
        const deadWinner = owner?.queue === true && processIsAlive(owner.pid) === false;
        // Anything else follows the original rule: stale after two minutes unchanged.
        if (deadWinner || Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export async function withBoardWriteLock<T>(planningRootInput: string, callback: () => Promise<T>): Promise<T> {
  const planningRoot = resolve(planningRootInput);
  const activeLocks = heldLocks.getStore();
  if (activeLocks?.has(planningRoot)) return callback();

  await mkdir(planningRoot, { recursive: true });
  const lockPath = join(planningRoot, LOCK_DIR);
  const token = randomUUID();
  const ticket = await enterQueue(join(planningRoot, QUEUE_DIR), token);
  try {
    await takeLegacyLock(lockPath, token);
  } catch (error) {
    await rm(ticket, { force: true });
    throw error;
  }

  const nextLocks = new Set(activeLocks ?? []);
  nextLocks.add(planningRoot);
  // A long hold (a large Take Online) keeps the original lock's time current,
  // so older versions never treat it as stale.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try {
    return await heldLocks.run(nextLocks, callback);
  } finally {
    clearInterval(heartbeat);
    if ((await readJsonFile<LockOwner>(join(lockPath, "owner.json")))?.token === token) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(ticket, { force: true });
  }
}

function idempotencyPath(planningRoot: string) {
  return join(planningRoot, IDEMPOTENCY_FILE);
}

async function readIdempotencyStore(planningRoot: string): Promise<IdempotencyStore> {
  try {
    const parsed = JSON.parse(await readFile(idempotencyPath(planningRoot), "utf8")) as Partial<IdempotencyStore>;
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records as IdempotencyRecord[] : [],
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "idempotencyKey")
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

export function idempotencyFingerprint(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

async function writeIdempotencyStore(planningRoot: string, store: IdempotencyStore) {
  await atomicWriteFile(idempotencyPath(planningRoot), JSON.stringify(store, null, 2) + "\n");
}

function pruneIdempotencyRecords(records: IdempotencyRecord[]) {
  const cutoff = Date.now() - IDEMPOTENCY_RETENTION_MS;
  return [...records]
    .filter((record) => Date.parse(record.createdAt) >= cutoff)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, IDEMPOTENCY_MAX_RECORDS)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

export async function runIdempotentBoardMutation<T>(input: {
  planningRoot: string;
  idempotencyKey?: string | undefined;
  scope: string;
  fingerprint: string;
  run: () => Promise<T>;
}): Promise<{ replayed: boolean; value: T }> {
  return withBoardWriteLock(input.planningRoot, async () => {
    const key = input.idempotencyKey?.trim();
    if (!key) return { replayed: false, value: await input.run() };

    const store = await readIdempotencyStore(input.planningRoot);
    const existing = store.records.find((record) => record.key === key && record.scope === input.scope);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        throw new PlanbanIdempotencyConflictError("Idempotency key was already used with a different request.");
      }
      if (!("response" in existing)) {
        throw new PlanbanIdempotencyConflictError("Idempotent mutation is already in progress.");
      }
      return { replayed: true, value: existing.response as T };
    }

    const pendingRecord: IdempotencyRecord = {
      key,
      scope: input.scope,
      fingerprint: input.fingerprint,
      createdAt: new Date().toISOString(),
    };
    await writeIdempotencyStore(input.planningRoot, {
      version: 1,
      records: pruneIdempotencyRecords([...store.records, pendingRecord]),
    });

    try {
      const value = await input.run();
      const latestStore = await readIdempotencyStore(input.planningRoot);
      const completedRecord: IdempotencyRecord = {
        ...pendingRecord,
        completedAt: new Date().toISOString(),
        response: JSON.parse(JSON.stringify(value)) as unknown,
      };
      const records = pruneIdempotencyRecords([
        ...latestStore.records.filter((record) => !(record.key === key && record.scope === input.scope)),
        completedRecord,
      ]);
      await writeIdempotencyStore(input.planningRoot, { version: 1, records });
      return { replayed: false, value };
    } catch (error) {
      const latestStore = await readIdempotencyStore(input.planningRoot);
      await writeIdempotencyStore(input.planningRoot, {
        version: 1,
        records: latestStore.records.filter((record) => !(record.key === key && record.scope === input.scope)),
      });
      throw error;
    }
  });
}
