import { SetMetadata } from "@nestjs/common";

export const BRAND_SCOPE_KEY = "pubrick:brand-scope";

export type BrandResource =
  | "brand"
  | "topic"
  | "content"
  | "run"
  | "channel"
  | "calendarSlot"
  | "newsItem"
  | "media"
  | "knowledge"
  | "source"
  | "sourceItem"
  | "memorableDate"
  | "publication"
  | "adaptation"
  | "generationJob";

export type BrandScopeMetadata =
  | {
      kind: "brand";
      source: "param" | "query" | "body";
      key?: string;
      roles?: "member" | "manager";
    }
  | {
      kind: "resource";
      resource: BrandResource;
      source?: "param" | "query" | "body";
      key?: string;
      roles?: "member" | "manager";
    }
  /** The repository must restrict every returned row to visible brands. */
  | { kind: "org-list" }
  /** A genuinely organization-wide operation; manager means owner or admin. */
  | {
      kind: "org";
      roles: "member" | "manager";
      /** Optional brand grant for an editorial POST that has no tenant write. */
      editorialBrand?: { source: "body"; key: "brandId" };
    };

/** Every ActiveOrgGuard route declares how its brand access is determined. */
export const BrandScope = (scope: BrandScopeMetadata) => SetMetadata(BRAND_SCOPE_KEY, scope);
