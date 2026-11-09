export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN_FOR_ACTOR"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "APPROVAL_EXPIRED"
  | "PARSE_FAILED"
  | "PAYPAL_ERROR";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN_FOR_ACTOR: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  APPROVAL_EXPIRED: 410,
  PARSE_FAILED: 422,
  PAYPAL_ERROR: 502,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

/** Only humans (dashboard or voice) may commit: confirm, approve, unfreeze, refund. */
export function assertHuman(actor: string) {
  if (!actor.startsWith("user:")) {
    throw new AppError("FORBIDDEN_FOR_ACTOR", `${actor} cannot do this; a human must`);
  }
}
