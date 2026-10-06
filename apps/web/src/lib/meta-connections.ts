import {
  META_CONNECTION_PROVIDERS,
  type MetaConnectionProvider,
  metaAuthorizationStartedSchema,
} from "@pubrick/shared";

export function isMetaConnectionProvider(value: string): value is MetaConnectionProvider {
  return (META_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

/** A failed or incomplete configuration read must never appear as an unavailable application. */
export function readMetaConfiguration(value: unknown): Record<MetaConnectionProvider, boolean> {
  if (
    !value ||
    typeof value !== "object" ||
    !("providers" in value) ||
    !Array.isArray(value.providers) ||
    value.providers.length !== META_CONNECTION_PROVIDERS.length
  )
    throw new Error("Meta configuration could not be read");
  const available: Partial<Record<MetaConnectionProvider, boolean>> = {};
  const entries: readonly unknown[] = value.providers;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("provider" in entry) ||
      !("available" in entry) ||
      typeof entry.provider !== "string" ||
      !isMetaConnectionProvider(entry.provider) ||
      typeof entry.available !== "boolean" ||
      Object.hasOwn(available, entry.provider)
    )
      throw new Error("Meta configuration could not be read");
    available[entry.provider] = entry.available;
  }
  return available as Record<MetaConnectionProvider, boolean>;
}

export function metaAuthorizationUrl(provider: MetaConnectionProvider, value: unknown): string {
  const result = metaAuthorizationStartedSchema.parse(value);
  if (result.provider !== provider) throw new Error("The authorization provider changed");
  return result.authorizationUrl;
}

/** A connection response can navigate only to the selected provider's fixed authorization page. */
export function openMetaAuthorization(provider: MetaConnectionProvider, value: unknown) {
  window.location.assign(metaAuthorizationUrl(provider, value));
}
