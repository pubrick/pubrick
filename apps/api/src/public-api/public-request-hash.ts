import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import {
  idempotencyKeySchema,
  PUBLIC_REQUEST_HASH_VERSION,
  type PublicWriteOperation,
} from "@pubrick/shared";
import { configure } from "safe-stable-stringify";

const stringify = configure({
  deterministic: true,
  strict: true,
  bigint: false,
  circularValue: Error,
});
/** Only validated JSON DTOs enter here. Optional undefined properties mean omission; arrays retain order. */
export function publicRequestHash(operation: PublicWriteOperation, dto: unknown): string {
  const value = stringify({ version: PUBLIC_REQUEST_HASH_VERSION, operation, dto });
  if (!value) throw new Error("Missing normalized request");
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function publicIdempotencyKey(value: unknown, rawHeaders: readonly string[]): string {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2)
    if (rawHeaders[i]?.toLowerCase() === "idempotency-key") count++;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success || count > 1)
    throw new HttpException(
      { code: "invalid_request", message: "A single valid Idempotency-Key is required" },
      400,
    );
  return parsed.data;
}
