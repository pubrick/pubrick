import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same-origin: /api/auth/* is proxied to the api server by next.config rewrites.
export const authClient = createAuthClient({ plugins: [organizationClient()] });
