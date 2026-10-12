// Board errors shared by every authority (local files and, later, the hosted
// Online Board service). Nothing here touches files, the network or the clock.

export class PlanbanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanConflictError";
  }
}

export class PlanbanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanValidationError";
  }
}

export class PlanbanNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanNotFoundError";
  }
}
