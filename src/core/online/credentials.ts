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
  });
}

export async function onlineStatus() {
  const { services } = await readCredentials();
  return Object.entries(services).map(([url, credentials]) => ({
    url, person: credentials.person ?? null, expiresAt: credentials.expiresAt,
  }));
}
