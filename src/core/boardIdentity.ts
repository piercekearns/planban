// A board's durable identity: a random id kept in its planning folder. Copies
// of the folder carry it, so an Online Board can recognise an old local copy
// of itself however much either has changed since. A board kept as a separate
// copy gets a new one. Boards made before this existed get one when first
// taken online; their older copies are recognised by shared history instead.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./persistence";

const IDENTITY_FILE = "board-identity.json";

export async function readBoardIdentity(planningRoot: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(planningRoot, IDENTITY_FILE), "utf8")) as { uid?: unknown };
    return typeof parsed.uid === "string" && /^[a-f0-9-]{36}$/.test(parsed.uid) ? parsed.uid : null;
  } catch {
    return null;
  }
}

export async function writeBoardIdentity(planningRoot: string, uid: string = randomUUID()): Promise<string> {
  await atomicWriteFile(join(planningRoot, IDENTITY_FILE), JSON.stringify({ uid, createdAt: new Date().toISOString() }, null, 2) + "\n");
  return uid;
}

export async function ensureBoardIdentity(planningRoot: string): Promise<string> {
  return (await readBoardIdentity(planningRoot)) ?? writeBoardIdentity(planningRoot);
}
