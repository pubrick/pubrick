import { BillingError } from "@pubrick/billing";
import { z } from "zod";

const locale = z.enum(["en", "ru", "es", "pt"]);
export const checkoutInputSchema = z
  .object({ planId: z.string().trim().min(1).max(100), locale })
  .strict();
export const localeInputSchema = z.object({ locale }).strict();
export function webhookInput(request: {
  rawBody?: unknown;
  headers: Record<string, unknown>;
  body?: unknown;
}): { bytes: Buffer; signature: string } {
  const signature = request.headers["stripe-signature"];
  if (
    !Buffer.isBuffer(request.rawBody) ||
    request.rawBody.length === 0 ||
    request.rawBody.length > 1024 * 1024 ||
    typeof signature !== "string" ||
    signature.length === 0 ||
    signature.length > 4096
  )
    throw new BillingError("invalid_signature");
  return { bytes: request.rawBody, signature };
}
