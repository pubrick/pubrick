import { createHash } from "node:crypto";
import {
  CONTENT_REUSE_HASH_VERSION,
  CONTENT_REUSE_OPERATIONS,
  type ContentReuseOperation,
  type ContentReuseSourceDigestPayload,
  contentReuseCreateSchema,
  contentReuseRetrySchema,
  contentReuseSourceDigestPayloadSchema,
} from "@pubrick/shared";
import { configure } from "safe-stable-stringify";
import { z } from "zod";

const stringify = configure({
  deterministic: true,
  strict: true,
  bigint: false,
  circularValue: Error,
});
const operationSchema = z.enum(CONTENT_REUSE_OPERATIONS);
const targetSchema = z.uuid();

function digest(value: unknown): string {
  const serialized = stringify(value);
  if (!serialized) throw new Error("Missing normalized reuse identity");
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/** Exact saved title and revision bind the normalized material shown in the preview. */
export function hashContentReuseSource(payload: ContentReuseSourceDigestPayload): string {
  return digest(contentReuseSourceDigestPayloadSchema.parse(payload));
}

/** Immutable operation targets remain part of replay identity after their rows are deleted. */
export function hashContentReuseRequest(
  operation: ContentReuseOperation,
  targetId: string,
  body: unknown,
): string {
  const parsedOperation = operationSchema.parse(operation);
  return digest({
    version: CONTENT_REUSE_HASH_VERSION,
    operation: parsedOperation,
    requestTargetKind: parsedOperation === "reuse" ? "content" : "run",
    requestTargetId: targetSchema.parse(targetId),
    body:
      parsedOperation === "reuse"
        ? contentReuseCreateSchema.parse(body)
        : contentReuseRetrySchema.parse(body),
  });
}
