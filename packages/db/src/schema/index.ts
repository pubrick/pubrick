// Domain tables arrive in later plans (auth/orgs, brands, channels, ...).
// This file must exist for drizzle-kit; keep exports here as tables are added.
export * from "./auth.js";
export * from "./content.js";
export * from "./content-items.js";
export * from "./generation.js";
