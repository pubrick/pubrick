/** The attempt will never succeed as-is: bad credentials, missing rights, invalid payload. */
export class PermanentError extends Error {
  readonly name = "PermanentError";
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** The attempt may succeed later: rate limit, platform outage, network failure. */
export class TransientError extends Error {
  readonly name = "TransientError";
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
