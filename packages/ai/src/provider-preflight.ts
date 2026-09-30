import { PermanentError, type RunFailure, TransientError } from "@pubrick/shared";

/** Created only by local guards/auth, before a model HTTP request is dispatched. */
export class ProviderPreflightError extends PermanentError {
  readonly providerRequestDispatched = false;
  constructor(
    message: string,
    readonly runFailure: RunFailure = "provider_refused",
  ) {
    super(message);
  }
}
export class ProviderPreflightTransientError extends TransientError {
  readonly providerRequestDispatched = false;
  constructor(
    message: string,
    readonly runFailure: RunFailure = "rate_limited",
  ) {
    super(message);
  }
}
export function preflightError(
  error: unknown,
): ProviderPreflightError | ProviderPreflightTransientError | undefined {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (
      current instanceof ProviderPreflightError ||
      current instanceof ProviderPreflightTransientError
    )
      return current;
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}
