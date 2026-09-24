import { z } from "zod";
import { normalizeNewlines } from "../provenance.js";
import { hasNulByte } from "./text.js";

export const CLIENT_REVIEW_VERDICTS = ["approved", "changes_requested"] as const;
export type ClientReviewVerdict = (typeof CLIENT_REVIEW_VERDICTS)[number];

export const clientReviewCreateSchema = z.object({
  expiresInHours: z.number().int().min(1).max(168).default(72),
});
export type ClientReviewCreate = z.infer<typeof clientReviewCreateSchema>;

export const clientReviewVerdictSchema = z
  .object({
    verdict: z.enum(CLIENT_REVIEW_VERDICTS),
    comment: z
      .string()
      .refine((value) => !hasNulByte(value), { message: "comment contains a NUL byte" })
      .transform(normalizeNewlines)
      .pipe(z.string().max(2000))
      .optional(),
  })
  .refine((value) => value.verdict !== "changes_requested" || !!value.comment?.trim(), {
    path: ["comment"],
    message: "requesting changes requires a comment",
  });
export type ClientReviewVerdictInput = z.infer<typeof clientReviewVerdictSchema>;

export const clientReviewStatusSchema = z.object({
  status: z.enum([
    "none",
    "pending",
    "approved",
    "changes_requested",
    "expired",
    "revoked",
    "stale",
  ]),
  expiresAt: z.iso.datetime().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  comment: z.string().nullable(),
});
export type ClientReviewStatus = z.infer<typeof clientReviewStatusSchema>;

export const clientReviewCreatedSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
  status: z.literal("pending"),
});
export type ClientReviewCreated = z.infer<typeof clientReviewCreatedSchema>;

export const clientReviewGuestSchema = z.object({
  status: z.enum(CLIENT_REVIEW_VERDICTS).or(z.literal("pending")),
  expiresAt: z.iso.datetime(),
  preview: z.object({
    title: z.string(),
    body: z.string(),
    channels: z.array(z.object({ name: z.string(), platform: z.string(), body: z.string() })),
    coverUrl: z.string().nullable(),
    videoUrl: z.string().nullable(),
  }),
  comment: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
});
export type ClientReviewGuest = z.infer<typeof clientReviewGuestSchema>;

export const clientReviewVerdictResultSchema = z.object({
  status: z.enum(CLIENT_REVIEW_VERDICTS),
  comment: z.string().nullable(),
  reviewedAt: z.iso.datetime(),
});
export type ClientReviewVerdictResult = z.infer<typeof clientReviewVerdictResultSchema>;
