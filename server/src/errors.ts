import { ERRORS, type ErrorCode } from "@signup/shared";

export type { ErrorCode };

/** A refused request. Carries a stable code for logs and a message for the person. */
export class GameError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(ERRORS[code]);
  }
}
