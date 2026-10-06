import { linkedinAuthorizationStartedSchema } from "@pubrick/shared";

/** Validate the only permitted provider redirect before changing browser location. */
export function openLinkedInAuthorization(value: unknown) {
  const result = linkedinAuthorizationStartedSchema.parse(value);
  window.location.assign(result.authorizationUrl);
}
