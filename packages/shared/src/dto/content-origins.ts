/** Saved authorship origin; also used by permission-safe internal source projections. */
export const CONTENT_ORIGINS = ["ai", "human", "external"] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];
