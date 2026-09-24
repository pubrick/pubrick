// Domain tables arrive in later plans (auth/orgs, brands, channels, ...).
// This file must exist for drizzle-kit; keep exports here as tables are added.
export * from "./auth.js";
export * from "./autopilot.js";
export * from "./calendar.js";
export * from "./client-review.js";
export * from "./content.js";
export * from "./content-items.js";
export * from "./draft-revision.js";
export * from "./editorial-notes.js";
export * from "./feeds.js";
export * from "./generation.js";
export * from "./knowledge.js";
export * from "./media.js";
export * from "./memorable-dates.js";
export * from "./notifications.js";
export * from "./prompts.js";
export * from "./publication-metrics.js";
export * from "./readapt.js";
export * from "./refine.js";
export * from "./sources.js";
export * from "./topics.js";
