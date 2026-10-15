// Which Planban account this computer is signed in as, for each service, and
// which account each of its online boards belongs to (owner request, 15
// October 2026). One account per service address is signed in at a time, so
// a board taken online under another account can't open until that account
// signs in again; with these facts the app can say so plainly. Everything
// here is kept on this computer (mode 600), never in a project's files.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PlanbanConflictError } from "../boardOperations";
import { onlineRequest } from "./client";
import { credentialsRoot, readCredentials, saveCredentials, serviceUrl, withCredentialsLock } from "./credentials";

export interface OnlineAccount {
  /** The account's id at the service. */
  person: string;
  email?: string | undefined;
  name?: string | undefined;
}

interface Me {
  userId: string;
  person?: { name?: string; email?: string };
}

/** The account signed in to `url` on this computer, as last recorded (no network). */
export async function signedInAccount(url: string): Promise<OnlineAccount | null> {
  const credentials = (await readCredentials()).services[serviceUrl(url)];
  if (!credentials?.person) return null;
  return { person: credentials.person, ...(credentials.email ? { email: credentials.email } : {}) };
}

/**
 * After signing in: asks the service who this is and keeps the email beside
 * the sign-in. The profile is filled in just after sign-in, so the email may
 * take a moment to appear.
 */
export async function rememberIdentity(url: string, attempts = 4): Promise<Me & { account: OnlineAccount }> {
  let me = await onlineRequest<Me>(url, "/api/v1/me");
  for (let attempt = 1; attempt < attempts && !me.person?.email; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    me = await onlineRequest<Me>(url, "/api/v1/me");
  }
  const key = serviceUrl(url);
  const credentials = (await readCredentials()).services[key];
  if (credentials) await saveCredentials(key, { ...credentials, person: me.userId, ...(me.person?.email ? { email: me.person.email } : {}) });
  return { ...me, account: { person: me.userId, ...(me.person?.email ? { email: me.person.email } : {}), ...(me.person?.name ? { name: me.person.name } : {}) } };
}

/**
 * The account still signed in to `url`, checked with the service: null when
 * nothing is signed in or the sign-in has ended (so nothing is lost by
 * signing in again).
 */
export async function liveAccount(url: string): Promise<OnlineAccount | null> {
  const stored = (await readCredentials()).services[serviceUrl(url)];
  if (!stored) return null;
  try {
    const me = await onlineRequest<Me>(url, "/api/v1/me");
    return { person: me.userId, ...(me.person?.email ?? stored.email ? { email: me.person?.email ?? stored.email } : {}) };
  } catch {
    return null;
  }
}

export class AccountInUseError extends PlanbanConflictError {
  constructor(readonly url: string, readonly account: OnlineAccount, howToContinue?: string) {
    const who = account.email ?? account.name;
    super((who
      ? `This computer is signed in as ${who}. Signing in as a different account signs ${who} out here. ${who}'s online boards stay online but won't open here until you sign back in as ${who}.`
      : "This computer is already signed in to Planban. Signing in as a different account signs that account out here. Its online boards stay online but won't open here until you sign back in as it.")
      + (howToContinue ? ` ${howToContinue}` : ""));
    this.name = "AccountInUseError";
  }
}

// --- which account each online board belongs to -------------------------------

interface BoardAccountsFile {
  version: 1;
  /** Keyed "<service>|<board id>". */
  boards: Record<string, OnlineAccount & { at: string }>;
}

const boardAccountsPath = () => join(credentialsRoot(), "board-accounts.json");

async function readBoardAccounts(): Promise<BoardAccountsFile> {
  try {
    const file = JSON.parse(await readFile(boardAccountsPath(), "utf8")) as BoardAccountsFile;
    return file.version === 1 && file.boards && typeof file.boards === "object" ? file : { version: 1, boards: {} };
  } catch {
    return { version: 1, boards: {} };
  }
}

/** Notes the account this computer used for a board: when it took it online, or attached to it. */
export async function recordBoardAccount(url: string, boardId: string, account: OnlineAccount) {
  await withCredentialsLock(async () => {
    const file = await readBoardAccounts();
    file.boards[`${serviceUrl(url)}|${boardId}`] = { ...account, at: new Date().toISOString() };
    const root = credentialsRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `.board-accounts-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, boardAccountsPath());
    } finally {
      await rm(temp, { force: true });
    }
  });
}

/** Notes the board under the account signed in now, if there is one. */
export async function recordBoardAccountNow(url: string, boardId: string) {
  const account = await signedInAccount(url);
  if (account) await recordBoardAccount(url, boardId, account);
}

export async function boardAccount(url: string, boardId: string): Promise<OnlineAccount | null> {
  return (await readBoardAccounts()).boards[`${serviceUrl(url)}|${boardId}`] ?? null;
}

/**
 * A board the service says it can't find, but that this computer used under
 * a different account than the one signed in now: it belongs to that account.
 */
export class BoardOfAnotherAccountError extends PlanbanConflictError {
  readonly statusCode = 403;
  constructor(readonly url: string, readonly boardId: string, readonly boardAccount: OnlineAccount, readonly signedIn: OnlineAccount) {
    const board = boardAccount.email ?? boardAccount.name;
    super(`This board belongs to another Planban account${board ? ` (${board})` : ""}. Sign in as that account, or ask its owner to invite ${signedIn.email ?? signedIn.name ?? "the account signed in here"}.`);
    this.name = "BoardOfAnotherAccountError";
  }
}

/** Turns "not found" into "another account's board" when this computer's own records say so. */
export async function explainMissingBoard(url: string, boardId: string, error: unknown): Promise<never> {
  const [board, signedIn] = await Promise.all([boardAccount(url, boardId).catch(() => null), signedInAccount(url).catch(() => null)]);
  if (board && signedIn && board.person !== signedIn.person) throw new BoardOfAnotherAccountError(url, boardId, board, signedIn);
  throw error;
}
