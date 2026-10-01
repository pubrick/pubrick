import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

const id = "90ebcfc4-e20a-4b03-8501-0e883767a137",
  brandId = "0d139af6-c7a0-46f8-bfb7-b4111d8c3121",
  channelId = "d6ab65a0-8145-4a22-82fa-956042f43c2a";
it("exposes v2 write tools with explicit consent and forwards stable keys through actual stdio", async () => {
  const requests: {
    url: string;
    key: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  let polls = 0;
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url ?? "",
      key: req.headers["idempotency-key"] as string | undefined,
      authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });
    if (req.url?.includes("/runs/")) polls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.includes("/runs/")
          ? {
              id,
              status: "succeeded",
              contentItemId: null,
              error: null,
              cost:
                polls === 1
                  ? { status: "unknown" }
                  : { status: "known", amountUsd: "0.0123", estimated: polls === 2 },
            }
          : req.url?.includes("/runs")
            ? { id, status: "queued" }
            : { id, status: "draft", origin: "external", requiresReview: true },
      ),
    );
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const child = spawn(process.execPath, ["dist/cli.js"], {
    env: {
      ...process.env,
      PUBRICK_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      PUBRICK_API_KEY: "read_fixture",
      PUBRICK_API_VERSION: "v2",
      PUBRICK_CONTENT_CREATE_API_KEY: "draft_fixture",
      PUBRICK_GENERATION_API_KEY: "generation_fixture",
      PUBRICK_PUBLICATIONS_API_KEY: undefined,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  type RpcResponse = {
    error?: unknown;
    result: {
      tools: Array<{ name: string; annotations?: Record<string, boolean> }>;
      isError?: boolean;
      structuredContent: { cost?: { status: string; estimated?: boolean; amountUsd?: string } };
    };
  };
  const pending = new Map<number, (value: RpcResponse) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let sequence = 0;
  const call = (method: string, params: unknown) =>
    new Promise<RpcResponse>((resolve, reject) => {
      const number = ++sequence;
      const timer = setTimeout(() => reject(new Error("MCP fixture timeout")), 5000);
      pending.set(number, (value) => {
        clearTimeout(timer);
        pending.delete(number);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: number, method, params })}\n`);
    });
  try {
    await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const tools = (await call("tools/list", {})).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_content",
      "get_content",
      "create_draft",
      "create_generation",
      "get_generation",
    ]);
    expect(tools.find((tool) => tool.name === "create_generation")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const argumentsRun = {
      brandId,
      channelIds: [channelId],
      brief: "Write a post",
      idempotencyKey: "stable.run-123",
    };
    const refused = await call("tools/call", {
      name: "create_generation",
      arguments: argumentsRun,
    });
    expect(refused.error ?? refused.result?.isError).toBeTruthy();
    expect(requests).toHaveLength(0);
    const draft = {
      brandId,
      channelIds: [channelId],
      body: "Imported",
      idempotencyKey: "stable.draft-123",
    };
    const first = await call("tools/call", { name: "create_draft", arguments: draft });
    expect(first.result.structuredContent).toEqual({
      id,
      status: "draft",
      origin: "external",
      requiresReview: true,
    });
    await call("tools/call", { name: "create_draft", arguments: draft });
    expect(requests[0]).toEqual({
      url: "/api/v2/content",
      key: "stable.draft-123",
      authorization: "Bearer draft_fixture",
      body: { brandId, channelIds: [channelId], body: "Imported" },
    });
    expect(requests[1]).toEqual(requests[0]);
    await call("tools/call", {
      name: "create_generation",
      arguments: {
        ...argumentsRun,
        allowPaidGeneration: true,
        consentVersion: "byok-paid-generation-v1",
      },
    });
    const status = await call("tools/call", { name: "get_generation", arguments: { id } });
    expect(status.result.structuredContent.cost).toEqual({ status: "unknown" });
    for (const estimated of [true, false]) {
      const known = await call("tools/call", { name: "get_generation", arguments: { id } });
      expect(known.result.structuredContent.cost).toEqual({
        status: "known",
        amountUsd: "0.0123",
        estimated,
      });
    }
    expect(
      requests.slice(2).every((request) => request.authorization === "Bearer generation_fixture"),
    ).toBe(true);
  } finally {
    lines.close();
    child.kill();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
}, 15000);
