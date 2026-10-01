import { SetMetadata } from "@nestjs/common";
import type { ContentReuseOperation } from "@pubrick/shared";

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
      /** Fixed session operation lookup precedes resource existence for durable replay. */
      sessionOperation?: ContentReuseOperation;
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
      /** Own identity only; repositories must bind writes to the verified session user. */
      selfService?: "telegram-binding";
      /** Optional brand grant for an editorial POST that has no tenant write. */
      editorialBrand?: { source: "body"; key: "brandId" };
    };

/** Every ActiveOrgGuard route declares how its brand access is determined. */
export const BrandScope = (scope: BrandScopeMetadata) => SetMetadata(BRAND_SCOPE_KEY, scope);
