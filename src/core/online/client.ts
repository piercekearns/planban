import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "../boardOperations";
import { readCredentials, serviceUrl, type OnlineCredentials } from "./credentials";

export class OnlineAuthenticationError extends Error {
  constructor(message: string, public readonly statusCode = 401) {
    super(message);
    this.name = "OnlineAuthenticationError";
  }
}

function loginRequired(url: string) {
  return new OnlineAuthenticationError(`Online Board sign-in expired or is missing. Run planban online login ${url}.`);
}

export async function requireCredentials(url: string): Promise<OnlineCredentials> {
  const credentials = (await readCredentials()).services[serviceUrl(url)];
  if (!credentials) throw loginRequired(url);
  return credentials;
}

export interface OnlineRequestOptions {
  signal?: AbortSignal;
  /**
   * Sent as Idempotency-Key. A request that fails on the network is retried
   * once with the same key and body, so the service applies it at most once.
   */
  idempotencyKey?: string;
  /** Overall time limit for one attempt; 30 seconds unless set. */
  timeoutMs?: number;
  /**
   * Use exactly these credentials rather than whatever is saved now, so that
   * several requests are sure to act as one account even if someone signs in
   * as another meanwhile.
   */
  credentials?: OnlineCredentials;
}

export async function onlineRequest<T>(urlInput: string, path: string, body?: unknown, options: OnlineRequestOptions = {}): Promise<T> {
  return (await authorizedResponse(urlInput, path, body, options)).json() as Promise<T>;
}

/** Raw bytes sent with PUT (one part of an attachment upload). Safe to repeat. */
class RawBody {
  constructor(readonly bytes: Uint8Array) {}
}

export async function putBytes<T>(urlInput: string, path: string, bytes: Uint8Array): Promise<T> {
  return (await authorizedResponse(urlInput, path, new RawBody(bytes), { timeoutMs: 5 * 60_000 })).json() as Promise<T>;
}

/** A GET whose answer is a file. */
export async function requestBytes(urlInput: string, path: string): Promise<Uint8Array> {
  const response = await authorizedResponse(urlInput, path, undefined, { timeoutMs: 10 * 60_000 });
  return new Uint8Array(await response.arrayBuffer());
}

async function authorizedResponse(urlInput: string, path: string, body: unknown, options: OnlineRequestOptions): Promise<Response> {
  const url = serviceUrl(urlInput);
  // Machine sign-ins, keys and development sign-ins do not expire by time or
  // refresh; when the service stops accepting one, the person signs in again.
  const credentials = options.credentials ?? await requireCredentials(url);
  const raw = body instanceof RawBody;
  const payload = body === undefined ? undefined : raw ? new Blob([body.bytes as Uint8Array<ArrayBuffer>]) : JSON.stringify(body);
  const send = () => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : raw ? "PUT" : "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": raw ? "application/octet-stream" : "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    ...(payload === undefined ? {} : { body: payload }),
    redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]) : AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  // Reads and keyed writes are safe to repeat after a network failure.
  const retryable = body === undefined || raw || !!options.idempotencyKey;
  const request = async () => {
    try {
      return await send();
    } catch (error) {
      if (!retryable || options.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return send();
    }
  };
  const response = await request();
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
    // A daily limit (owner decision 18): kept as 429 so the board page and agents see a limit, not a failure.
    if (response.status === 429) throw Object.assign(new Error(message), { name: "OnlineLimitError", statusCode: 429 });
    throw new Error(message);
  }
  return response;
}

export function boardPath(boardId: string, suffix = "") {
  return `/api/v1/boards/${encodeURIComponent(boardId)}${suffix}`;
}
