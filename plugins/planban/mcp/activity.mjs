import { randomUUID } from "node:crypto";

const TARGETED_ACTIVITY_TOOLS = new Set([
  "planban_get_card",
  "planban_read_doc",
  "planban_move_card",
  "planban_update_card",
  "planban_set_card_parent",
  "planban_write_doc",
]);

export function activityTargetForTool(name, args) {
  if (!TARGETED_ACTIVITY_TOOLS.has(name)) return null;
  return typeof args?.cardId === "string" && args.cardId.trim() ? args.cardId.trim() : null;
}

export function planbanActivityBaseUrl(env = process.env) {
  const raw = env.PLANBAN_ACTIVITY_URL?.trim() || "http://127.0.0.1:4317";
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PLANBAN_ACTIVITY_URL must be a local HTTP URL.");
  }
  return url.origin;
}

async function postActivity(fetchImpl, url, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startPlanbanMcpActivity(input) {
  const cardId = activityTargetForTool(input.name, input.args);
  if (!cardId) return null;
  let board;
  let baseUrl;
  try {
    board = await input.resolveBoard();
    baseUrl = planbanActivityBaseUrl(input.env);
  } catch {
    return null;
  }
  if (!board?.repoId) return null;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 80;
  const leaseId = input.leaseId ?? randomUUID();
  const endpoint = `${baseUrl}/api/boards/${encodeURIComponent(board.repoId)}/activity`;
  const body = { cardId, leaseId };
  const started = await postActivity(fetchImpl, `${endpoint}/start`, body, timeoutMs);
  if (!started) return null;
  let ended = false;
  return {
    repoId: board.repoId,
    cardId,
    leaseId,
    async end() {
      if (ended) return;
      ended = true;
      await postActivity(fetchImpl, `${endpoint}/end`, body, timeoutMs);
    },
  };
}
