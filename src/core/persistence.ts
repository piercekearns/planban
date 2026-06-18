import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

export async function withBoardWriteLock<T>(planningRootInput: string, callback: () => Promise<T>): Promise<T> {
  const planningRoot = resolve(planningRootInput);
  const activeLocks = heldLocks.getStore();
  if (activeLocks?.has(planningRoot)) return callback();

  await mkdir(planningRoot, { recursive: true });
  const lockPath = join(planningRoot, LOCK_DIR);
  let acquired = false;

  while (!acquired) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }) + "\n", "utf8");
      acquired = true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  const nextLocks = new Set(activeLocks ?? []);
  nextLocks.add(planningRoot);
  try {
    return await heldLocks.run(nextLocks, callback);
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
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
