// Domain failures cross from mutations to HTTP actions as ConvexError data,
// which Convex preserves, and the mutation's writes are rolled back.
import { ConvexError } from "convex/values";
import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "../../../../src/core/boardOperations";

export type ErrorCode = "conflict" | "validation" | "not_found" | "forbidden" | "unauthorized";
export type ServiceErrorData = {
  code: ErrorCode;
  message: string;
  currentRevision?: number;
};

export function fail(code: ErrorCode, message: string, extra: Partial<ServiceErrorData> = {}): never {
  throw new ConvexError<ServiceErrorData>({ code, message, ...extra });
}

/** Turns the shared planners' error classes into service errors. */
export function asServiceError(error: unknown, currentRevision?: number): ConvexError<ServiceErrorData> {
  if (error instanceof ConvexError) return error as ConvexError<ServiceErrorData>;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PlanbanConflictError) {
    return new ConvexError<ServiceErrorData>({ code: "conflict", message, ...(currentRevision === undefined ? {} : { currentRevision }) });
  }
  if (error instanceof PlanbanNotFoundError) return new ConvexError<ServiceErrorData>({ code: "not_found", message });
  if (error instanceof PlanbanValidationError) return new ConvexError<ServiceErrorData>({ code: "validation", message });
  // Some older planner checks throw plain errors; they are still input problems.
  if (/not found/i.test(message)) return new ConvexError<ServiceErrorData>({ code: "not_found", message });
  return new ConvexError<ServiceErrorData>({ code: "validation", message });
}
