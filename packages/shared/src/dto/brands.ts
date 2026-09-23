import { z } from "zod";
import { DEFAULT_CAMPAIGN_TEMPLATE } from "../link-policy-defaults.js";
import { PLATFORM_IDS } from "./channels.js";

const publicUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !!url.hostname;
  }, "Use an HTTP(S) URL without credentials");

const homepageUrl = publicUrl.refine((value) => {
  const url = new URL(value);
  return url.pathname === "/" && !url.search && !url.hash;
}, "Use a website homepage without a path, query or fragment");

export const brandLinkPolicySchema = z.strictObject({
  website: homepageUrl,
  campaignTemplate: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_{}-]+$/)
    .refine(
      (value) => !/[{}]/.test(value.replaceAll("{YYYY_MM}", "").replaceAll("{content_type}", "")),
      "Only {YYYY_MM} and {content_type} placeholders are supported",
    )
    .default(DEFAULT_CAMPAIGN_TEMPLATE),
  platforms: z
    .partialRecord(
      z.enum(PLATFORM_IDS),
      z.strictObject({
        source: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/),
        medium: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/),
      }),
    )
    .default({}),
});
export type BrandLinkPolicy = z.infer<typeof brandLinkPolicySchema>;

export const brandCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  voice: z.string().max(2000).optional(),
  audience: z.string().max(2000).optional(),
  contentLanguage: z.string().min(2).max(10).default("en"),
  linkPolicy: brandLinkPolicySchema.nullable().optional(),
});
export type BrandCreate = z.infer<typeof brandCreateSchema>;

export const brandUpdateSchema = brandCreateSchema.partial();
export type BrandUpdate = z.infer<typeof brandUpdateSchema>;
