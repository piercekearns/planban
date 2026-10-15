// One machine-readable shape for a failure, the same from the CLI (-o json)
// and the local MCP server (agent-surface audit, 15 October 2026): what kind of
// failure it is, the plain message, and the details an agent needs to act on
// it (the current revision after a conflict, the service to sign in to, the
// accounts involved). Never a secret.
import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "./boardOperations";
import { planbanCommand } from "./command";
import { PlanbanEditConflictError } from "./conflicts";
import { AccountInUseError, BoardOfAnotherAccountError } from "./online/accounts";
import { OnlineAuthenticationError, PlanbanForbiddenError } from "./online/client";

export type ErrorCategory =
  | "conflict" | "validation" | "not_found" | "signed_out" | "forbidden" | "limit"
  | "account_in_use" | "other_account" | "error";

export interface ErrorReport {
  category: ErrorCategory;
  message: string;
  details?: Record<string, unknown>;
}

export function errorReport(error: unknown): ErrorReport {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AccountInUseError) {
    return { category: "account_in_use", message, details: { url: error.url, signedInAs: error.account.email ?? null, retryWith: "--switch-account" } };
  }
  if (error instanceof BoardOfAnotherAccountError) {
    return { category: "other_account", message, details: { url: error.url, boardId: error.boardId, boardAccount: error.boardAccount.email ?? null, signedInAs: error.signedIn.email ?? null } };
  }
  if (error instanceof OnlineAuthenticationError && error.signIn) {
    return { category: "signed_out", message, details: { url: error.signIn.url, reason: error.signIn.reason, signInCommand: `${planbanCommand()} online login ${error.signIn.url}` } };
  }
  if (error instanceof PlanbanForbiddenError) return { category: "forbidden", message };
  if (error instanceof PlanbanEditConflictError) {
    return { category: "conflict", message, details: { currentRevision: error.conflict.currentRevision, conflict: error.conflict } };
  }
  if (error instanceof PlanbanConflictError) {
    const currentRevision = (error as { currentRevision?: unknown }).currentRevision;
    return { category: "conflict", message, ...(typeof currentRevision === "number" ? { details: { currentRevision } } : {}) };
  }
  if (error instanceof PlanbanNotFoundError) return { category: "not_found", message };
  if (error instanceof PlanbanValidationError) return { category: "validation", message };
  if (error instanceof Error && error.name === "OnlineLimitError") return { category: "limit", message };
  return { category: "error", message };
}
