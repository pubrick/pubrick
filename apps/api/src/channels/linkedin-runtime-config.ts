import type { LinkedInOAuthConfiguration } from "./linkedin-oauth-client";

/** No callback, endpoint or application can be selected by a tenant or request. */
export function linkedinRuntimeConfiguration(
  application: LinkedInOAuthConfiguration | undefined,
  authOrigin: string,
  webOrigin: string,
): { application: LinkedInOAuthConfiguration; redirectUri: string } | undefined {
  if (!application) return undefined;
  const auth = new URL(authOrigin);
  const web = new URL(webOrigin);
  if (
    auth.protocol !== "https:" ||
    auth.pathname !== "/" ||
    auth.search ||
    auth.hash ||
    auth.username ||
    auth.password ||
    web.origin !== auth.origin ||
    web.pathname !== "/" ||
    web.search ||
    web.hash ||
    web.username ||
    web.password
  )
    throw new Error(
      "LinkedIn authorization requires matching canonical HTTPS auth and web origins",
    );
  return { application, redirectUri: `${auth.origin}/en/connections/linkedin` };
}
