import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createPublicContentClient,
  createPublicDraftWriteClient,
  createPublicGenerationClient,
  createPublicPublicationClient,
  loadConfig,
} from "./api.js";
import { createServer } from "./server.js";

try {
  const { baseUrl, apiKey, publicationApiKey, apiVersion, contentCreateApiKey, generationApiKey } =
    loadConfig();
  const client = createPublicContentClient({ baseUrl, apiKey, apiVersion });
  const publicationClient = publicationApiKey
    ? createPublicPublicationClient({ baseUrl, apiKey: publicationApiKey })
    : undefined;
  // stdout belongs exclusively to the MCP transport; diagnostics go to stderr.
  serveStdio(
    () =>
      createServer(client, publicationClient, {
        apiVersion,
        draftClient: contentCreateApiKey
          ? createPublicDraftWriteClient({ baseUrl, apiKey: contentCreateApiKey })
          : undefined,
        generationClient: generationApiKey
          ? createPublicGenerationClient({ baseUrl, apiKey: generationApiKey })
          : undefined,
      }),
    {
      onerror: () => console.error("Pubrick MCP transport error."),
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pubrick MCP configuration is invalid.");
  process.exitCode = 1;
}
