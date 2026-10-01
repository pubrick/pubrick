import { readFileSync } from "node:fs";
import {
  adapterReceiptRole,
  appendReceipt,
  scriptedResponse,
  validateFixtureEnvironment,
} from "./recurring-model-fixture.mjs";

validateFixtureEnvironment(process.env);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual test-only preload is outside Turbo tasks.
const path = process.env.PUBRICK_E2E_RECEIPTS;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual test-only preload is outside Turbo tasks.
const marker = process.env.PUBRICK_E2E_JOURNEY_MARKER;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: runner-owned channel evidence outside Turbo tasks.
const channelContext = process.env.PUBRICK_E2E_CHANNEL_CONTEXT;
function receipt(record) {
  try {
    appendReceipt(path, { ...record, marker });
  } catch {
    process.stderr.write("Recurring fixture receipt storage failed\n");
    process.exit(78);
  }
}
// Test-only preload for this compiled worker. There is deliberately no original
// fetch fallback. This covers the SDK fetch transport, not every Node HTTP API.
globalThis.fetch = async (input, init) => {
  try {
    const request = new Request(input, init);
    const transportRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.json(),
    };
    const result = scriptedResponse(transportRequest, marker);
    const role =
      result.role === "adapter"
        ? adapterReceiptRole(
            transportRequest,
            JSON.parse(readFileSync(channelContext, "utf8")),
            marker,
          )
        : result.role;
    receipt({ kind: "call", role });
    return Response.json(result.response);
  } catch {
    // Persist the failure before throwing: a caught SDK failure cannot turn green.
    receipt({ kind: "unexpected" });
    throw new Error("Recurring fixture rejected an unexpected request");
  }
};
