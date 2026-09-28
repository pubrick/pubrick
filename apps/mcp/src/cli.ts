import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPublicContentClient, createPublicPublicationClient, loadConfig } from "./api.js";
import { createServer } from "./server.js";

try {
  const { baseUrl, apiKey, publicationApiKey } = loadConfig();
  const client = createPublicContentClient({ baseUrl, apiKey });
  const publicationClient = publicationApiKey
    ? createPublicPublicationClient({ baseUrl, apiKey: publicationApiKey })
    : undefined;
  // stdout belongs exclusively to the MCP transport; diagnostics go to stderr.
  serveStdio(() => createServer(client, publicationClient), {
    onerror: () => console.error("Pubrick MCP transport error."),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pubrick MCP configuration is invalid.");
  process.exitCode = 1;
}
