import type { MetaApplicationCredentials, MetaConnectionProvider } from "@pubrick/shared";

export type MetaApplicationConfiguration = MetaApplicationCredentials;

export interface MetaRuntimeConfiguration {
  provider: MetaConnectionProvider;
  application: MetaApplicationConfiguration;
  redirectUri: string;
}

/** Tenant requests cannot select callbacks, provider hosts or application secrets. */
export function metaRuntimeConfiguration(
  provider: MetaConnectionProvider,
  application: MetaApplicationConfiguration | undefined,
  authOrigin: string,
  webOrigin: string,
): MetaRuntimeConfiguration | undefined {
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
    throw new Error("Meta authorization requires matching canonical HTTPS auth and web origins");
  return {
    provider,
    application,
    redirectUri: `${auth.origin}/en/connections/meta/${provider}`,
  };
}
