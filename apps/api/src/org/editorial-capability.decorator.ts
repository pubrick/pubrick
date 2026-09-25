import { SetMetadata } from "@nestjs/common";

export const EDITORIAL_CAPABILITY_KEY = "pubrick:editorial-capability";

/**
 * Explicit mutation allowlist for the dedicated editorial roles. An editor can
 * also perform author work; owner/admin/member keep their established access.
 */
export type EditorialCapability = "author" | "editor";

export const EditorialCapability = (capability: EditorialCapability) =>
  SetMetadata(EDITORIAL_CAPABILITY_KEY, capability);
