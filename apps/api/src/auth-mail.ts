import { identity } from "./env";
export type AuthMailRequest = {
  recipient: string;
  link: string;
  locale: "en" | "es" | "ru" | "pt";
} & (
  | { kind: "verify" | "reset"; userId: string }
  | { kind: "invite"; invitationId: string; organizationId: string }
);
type Enqueue = (request: AuthMailRequest) => Promise<void>;
export function mailLocale(request?: Request): AuthMailRequest["locale"] {
  const value = request?.headers.get("x-pubrick-locale");
  return value === "es" || value === "ru" || value === "pt" ? value : "en";
}
/** Static auth callbacks bind to Nest's initialized queue; no transport or second pool. */
export function createAuthMailer() {
  let enqueue: Enqueue | undefined;
  const admitted = new Set<Promise<unknown>>();
  return {
    bind(next: Enqueue) {
      if (enqueue) throw new Error("Authentication mail queue is already bound.");
      enqueue = next;
    },
    async submit(request: AuthMailRequest): Promise<{ status: "queued" | "unavailable" }> {
      const next = enqueue;
      if (!next) {
        console.warn("Authentication email admission unavailable.");
        return { status: "unavailable" };
      }
      const task = Promise.resolve().then(() => next(request));
      admitted.add(task);
      try {
        await task;
        return { status: "queued" };
      } catch {
        console.warn("Authentication email admission unavailable.");
        return { status: "unavailable" };
      } finally {
        admitted.delete(task);
      }
    },
    async drain() {
      await Promise.allSettled([...admitted]);
    },
    async close() {
      enqueue = undefined;
      await Promise.allSettled([...admitted]);
    },
  };
}
export const authMailer = identity.mail ? createAuthMailer() : null;
export function invitationMailUrl(origin: string, invitationId: string, request?: Request) {
  const url = new URL(`/${mailLocale(request)}/onboarding`, origin);
  url.searchParams.set("invitation", invitationId);
  return url.href;
}
