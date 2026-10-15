import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultPlanbanRoot } from "../paths";
import { withBoardWriteLock } from "../persistence";
import { PlanbanValidationError } from "../boardOperations";

export interface OnlineCredentials {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  person?: string | undefined;
  /** The signed-in account's email, as the service last said (for showing who is signed in). */
  email?: string | undefined;
}

interface CredentialsFile {
  version: 1;
  services: Record<string, OnlineCredentials>;
}

export function serviceUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new PlanbanValidationError("Online Board URL must be an HTTPS origin (HTTP is allowed for loopback development).");
  }
  return url.origin;
}

export function credentialsRoot() {
  return join(defaultPlanbanRoot(), "online");
}

export function credentialsPath() {
  return join(credentialsRoot(), "credentials.json");
}

export function withCredentialsLock<T>(run: () => Promise<T>): Promise<T> {
  return withBoardWriteLock(credentialsRoot(), run);
}

export async function readCredentials(): Promise<CredentialsFile> {
  try {
    const file = JSON.parse(await readFile(join(credentialsRoot(), "credentials.json"), "utf8")) as CredentialsFile;
    if (file.version !== 1 || !file.services || typeof file.services !== "object") throw new Error("Invalid Online Board credentials file.");
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, services: {} };
    throw error;
  }
}

export async function saveCredentials(url: string, credentials: OnlineCredentials | null) {
  return withCredentialsLock(async () => {
    const file = await readCredentials();
    const key = serviceUrl(url);
    if (credentials) file.services[key] = credentials;
    else delete file.services[key];
    await writeCredentialsFile(file);
  });
}

/**
 * Adds facts about a sign-in (who it is) only if that same sign-in is still
 * the one saved: a slow answer about an earlier sign-in never lands on a newer one.
 */
export async function updateSignedIn(url: string, accessToken: string, facts: Pick<OnlineCredentials, "person" | "email">) {
  return withCredentialsLock(async () => {
    const file = await readCredentials();
    const key = serviceUrl(url);
    const current = file.services[key];
    if (!current || current.accessToken !== accessToken) return false;
    file.services[key] = { ...current, ...Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) };
    await writeCredentialsFile(file);
    return true;
  });
}

async function writeCredentialsFile(file: CredentialsFile) {
  const root = credentialsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = join(root, `.credentials-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, join(root, "credentials.json"));
  } finally {
    await rm(temp, { force: true });
  }
}

export async function onlineStatus() {
  const { services } = await readCredentials();
  return Object.entries(services).map(([url, credentials]) => ({
    // The email a person recognises, not the service's id for them (owner request, 15 October 2026).
    url, signedInAs: credentials.email ?? null, expiresAt: credentials.expiresAt,
  }));
}
