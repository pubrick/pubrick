import {
  type ContentReuseCreate,
  type ContentReuseRetry,
  contentReuseCreateSchema,
  contentReuseRetrySchema,
  contentReuseSourcePreviewSchema,
  idempotencyKeySchema,
} from "@pubrick/shared";

export type ReuseIdentity = { userId: string; orgId: string };
export type PendingContentReuse =
  | { operation: "reuse"; targetId: string; key: string; body: ContentReuseCreate }
  | { operation: "reuse-retry"; targetId: string; key: string; body: ContentReuseRetry };

// Retain confirmed requests across the application's SPA login round-trip.
// No cookies, provider secrets, source preview/material or browser storage.
// A hard reload clears this memory; unresolved entries are never evicted.
const pending = new Map<string, PendingContentReuse>();

function validIdentity(value: string) {
  return value.length > 0 && value.length <= 255 && !value.includes("\0");
}

function namespace(
  identity: ReuseIdentity,
  operation: PendingContentReuse["operation"],
  target: string,
) {
  const id = contentReuseSourcePreviewSchema.shape.id.safeParse(target);
  if (!validIdentity(identity.userId) || !validIdentity(identity.orgId) || !id.success) return null;
  return JSON.stringify([identity.userId, identity.orgId, operation, id.data.toLowerCase()]);
}

export function getPendingContentReuse(
  identity: ReuseIdentity,
  operation: PendingContentReuse["operation"],
  target: string,
) {
  const name = namespace(identity, operation, target);
  return name ? (pending.get(name) ?? null) : null;
}

export function retainPendingContentReuse(identity: ReuseIdentity, request: PendingContentReuse) {
  const name = namespace(identity, request.operation, request.targetId);
  if (!name) throw new Error("Invalid pending reuse identity");
  const key = idempotencyKeySchema.parse(request.key);
  const entry: PendingContentReuse =
    request.operation === "reuse"
      ? {
          operation: "reuse",
          targetId: request.targetId.toLowerCase(),
          key,
          body: contentReuseCreateSchema.parse(request.body),
        }
      : {
          operation: "reuse-retry",
          targetId: request.targetId.toLowerCase(),
          key,
          body: contentReuseRetrySchema.parse(request.body),
        };
  const existing = pending.get(name);
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
    throw new Error("Unresolved reuse operation already exists");
  if (entry.operation === "reuse") Object.freeze(entry.body.channelIds);
  Object.freeze(entry.body);
  pending.set(name, Object.freeze(entry));
}

export function settlePendingContentReuse(
  identity: ReuseIdentity,
  operation: PendingContentReuse["operation"],
  target: string,
  key: string,
) {
  const name = namespace(identity, operation, target);
  if (name && pending.get(name)?.key === key) pending.delete(name);
}
