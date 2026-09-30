import { defineConfig } from "vitest/config";

export default defineConfig({
  // Inline the maintained transport so offline DNS/Undici fixtures exercise its
  // actual destination and socket checks rather than dispatching live requests.
  test: { environment: "node", server: { deps: { inline: ["guarded-fetch"] } } },
});
