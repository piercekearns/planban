import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "../boardOperations";
import { readCredentials, saveCredentials, serviceUrl, withCredentialsLock, type OnlineCredentials } from "./credentials";

export class OnlineAuthenticationError extends Error {
  constructor(message: string, public readonly statusCode = 401) {
    super(message);
    this.name = "OnlineAuthenticationError";
  }
}

function loginRequired(url: string) {
  return new OnlineAuthenticationError(`Online Board sign-in expired or is missing. Run planban online login ${url}.`);
}

export async function authorizationMetadata(urlInput: string) {
  const url = serviceUrl(urlInput);
  const response = await fetch(`${url}/.well-known/oauth-authorization-server`, {
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Online Board OAuth metadata could not be loaded.");
  const metadata = await response.json();
  const endpoint = (name: string) => {
    const value = metadata[name];
    if (typeof value !== "string" || new URL(value).origin !== url) {
      throw new Error(`Online Board OAuth ${name} must belong to the service origin.`);
    }
    return value;
  };
  return { token: endpoint("token_endpoint"), register: endpoint("registration_endpoint"), authorize: endpoint("authorization_endpoint") };
}

export async function requireCredentials(url: string): Promise<OnlineCredentials> {
  const credentials = (await readCredentials()).services[serviceUrl(url)];
  if (!credentials) throw loginRequired(url);
  return credentials;
}

export async function tokenRequest(url: string, form: URLSearchParams): Promise<{
  access_token: string; refresh_token: string; expires_in: number;
}> {
  const metadata = await authorizationMetadata(url);
  const response = await fetch(metadata.token, {
    method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw loginRequired(url);
  const token = await response.json();
  if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in)) {
    throw new Error("Online Board token response is invalid.");
  }
  return token;
}

async function refresh(url: string, previous: OnlineCredentials) {
  // Serialize rotating refresh tokens across CLI, MCP and Board processes.
  return withCredentialsLock(async () => {
    const current = await requireCredentials(url);
    if (current.accessToken !== previous.accessToken) return current;
    const token = await tokenRequest(url, new URLSearchParams({
      grant_type: "refresh_token", refresh_token: current.refreshToken,
      client_id: current.clientId, resource: url,
    })).catch(() => { throw loginRequired(url); });
    const credentials = {
      ...current, accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    };
    await saveCredentials(url, credentials);
    return credentials;
  });
}

export interface OnlineRequestOptions {
  signal?: AbortSignal;
  /**
   * Sent as Idempotency-Key. A request that fails on the network is retried
   * once with the same key and body, so the service applies it at most once.
   */
  idempotencyKey?: string;
}

export async function onlineRequest<T>(urlInput: string, path: string, body?: unknown, options: OnlineRequestOptions = {}): Promise<T> {
  const url = serviceUrl(urlInput);
  let credentials = await requireCredentials(url);
  let refreshed = false;
  if (Date.parse(credentials.expiresAt) <= Date.now() + 60_000) {
    credentials = await refresh(url, credentials);
    refreshed = true;
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const send = () => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    ...(payload === undefined ? {} : { body: payload }),
    redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  // Reads and keyed writes are safe to repeat after a network failure.
  const retryable = body === undefined || !!options.idempotencyKey;
  const request = async () => {
    try {
      return await send();
    } catch (error) {
      if (!retryable || options.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return send();
    }
  };
  let response = await request();
  if (response.status === 401 && !refreshed) {
    await response.body?.cancel();
    credentials = await refresh(url, credentials);
    response = await request();
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = payload.error?.message ?? `Online Board request failed (${response.status}).`;
    if (response.status === 409) {
      const error = new PlanbanConflictError(message);
      Object.assign(error, { currentRevision: payload.currentRevision ?? payload.error?.currentRevision });
      throw error;
    }
    if (response.status === 400) throw new PlanbanValidationError(message);
    if (response.status === 404) throw new PlanbanNotFoundError(message);
    if (response.status === 401) throw loginRequired(url);
    if (response.status === 403) throw new OnlineAuthenticationError(`${message} Ask the board owner for access.`, 403);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function boardPath(boardId: string, suffix = "") {
  return `/api/v1/boards/${encodeURIComponent(boardId)}${suffix}`;
}
