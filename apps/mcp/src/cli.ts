import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPublicContentClient, loadConfig } from "./api.js";
import { createServer } from "./server.js";

try {
  const client = createPublicContentClient(loadConfig());
  // stdout belongs exclusively to the MCP transport; diagnostics go to stderr.
  serveStdio(() => createServer(client), {
    onerror: () => console.error("Pubrick MCP transport error."),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pubrick MCP configuration is invalid.");
  process.exitCode = 1;
}
