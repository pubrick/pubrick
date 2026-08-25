export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 403 raised by ActiveOrgGuard because the session has no active organization. */
    readonly noActiveOrg = false,
  ) {
    super(message);
  }
}

/**
 * What to actually show the user for a failed request.
 *
 * A 4xx is the server saying something specific and actionable about THIS
 * request — "Approved content cannot be edited; reject it first", "This
 * content has already been published", "No active organization" — and the
 * whole value of it is the detail. Collapsing that into a generic apology
 * throws away the only thing that tells the operator what to do next, so a
 * 4xx message is rendered as it came.
 *
 * A 5xx, or a failure with no HTTP status at all (network down, DNS, a proxy's
 * own error page), says nothing the user can act on and was never written for
 * them. Those collapse into the caller's translated fallback, which is the
 * point of the per-screen `genericError` keys.
 */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.status < 500 ? err.message : fallback;
}

/** Nest error bodies are `{ statusCode, message, error }`; message may be a string[]. */
function serverMessage(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
    if (Array.isArray(body.message) && body.message.length > 0) return body.message.join(", ");
  } catch {
    // Not JSON (proxy error page, gateway timeout) — never surface the raw body.
  }
  return undefined;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const raw = await res.text();
    const detail = serverMessage(raw);
    if (res.status === 401) {
      throw new ApiError(401, "Your session has expired. Please log in again.");
    }
    if (res.status === 403) {
      const noActiveOrg = /no active organization/i.test(detail ?? "");
      throw new ApiError(
        403,
        noActiveOrg
          ? "No active organization — create or select one first."
          : "You don't have access to this.",
        noActiveOrg,
      );
    }
    throw new ApiError(res.status, detail ?? res.statusText ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}
