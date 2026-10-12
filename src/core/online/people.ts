// People on an Online Board, from the command line: inviting (owner decisions
// 8 and 15: links last 7 days), joining from an invite link, the people list
// with what each person's agents may do, and choosing what your own agents may do.
import { PlanbanValidationError } from "../boardOperations";
import { readManifest, resolveProjectCwd } from "../storage";
import { boardPath, onlineRequest, requireCredentials } from "./client";
import { serviceUrl } from "./credentials";
import { attachOnline } from "./transfers";

type Level = "read" | "plan" | "complete";

async function onlineBoard(cwdInput: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind !== "online") throw new PlanbanValidationError("This project does not point to an Online Board.");
  return { cwd, url: manifest.storage.url, boardId: manifest.storage.boardId };
}

export async function invitePeople(cwdInput: string, options: { role?: "editor" | "viewer"; email?: string } = {}) {
  const { url, boardId } = await onlineBoard(cwdInput);
  return onlineRequest<{ link: string; emailSent: boolean; invite: { role: string; email: string | null; expiresAt: string } }>(
    url, boardPath(boardId, "/invites"), { role: options.role ?? "viewer", ...(options.email ? { email: options.email } : {}) });
}

export async function listPeople(cwdInput: string) {
  const { url, boardId } = await onlineBoard(cwdInput);
  return onlineRequest(url, boardPath(boardId, "/people"));
}

export async function setMyAgents(cwdInput: string, level: Level) {
  const { url, boardId } = await onlineBoard(cwdInput);
  return onlineRequest(url, boardPath(boardId, "/people/me/agents"), { level });
}

/**
 * Joins a board from an invite link with this machine's sign-in. With a
 * project folder, that project then uses the board.
 */
export async function joinBoard(link: string, options: { cwd?: string } = {}) {
  let origin: string;
  try {
    const parsed = new URL(link);
    if (!/^\/invite\/pbi_[A-Za-z0-9_-]{20,}$/.test(parsed.pathname)) throw new Error("not an invite");
    origin = serviceUrl(parsed.origin);
  } catch {
    throw new PlanbanValidationError("That is not a Planban invite link. It looks like https://app.planban.ai/invite/...");
  }
  await requireCredentials(origin);
  const joined = await onlineRequest<{ boardId: string; title: string; role: string; alreadyMember: boolean }>(origin, "/api/v1/invites/accept", { token: link });
  if (!options.cwd) return { ...joined, url: origin };
  const attached = await attachOnline(origin, joined.boardId, options.cwd);
  return { ...joined, url: origin, project: attached };
}
