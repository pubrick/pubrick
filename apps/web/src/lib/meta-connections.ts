import { type MetaConnectionProvider, metaAuthorizationStartedSchema } from "@pubrick/shared";

/** A connection response can navigate only to the selected provider's fixed authorization page. */
export function openMetaAuthorization(provider: MetaConnectionProvider, value: unknown) {
  const result = metaAuthorizationStartedSchema.parse(value);
  if (result.provider !== provider) throw new Error("The authorization provider changed");
  window.location.assign(result.authorizationUrl);
}
