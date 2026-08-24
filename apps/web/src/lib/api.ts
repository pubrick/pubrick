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
