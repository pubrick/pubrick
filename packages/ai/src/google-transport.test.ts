import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { TransientError } from "@pubrick/shared";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAiError, redactSecrets } from "./classify.js";
import { GeminiImageCaller } from "./gemini-image.js";
import {
  googleProxyEnvSchema,
  googleProxyFetch,
  isAllowedGoogleProxy,
} from "./google-transport.js";
import { embedKnowledgeText } from "./knowledge-embedding.js";
import {
  buildPaidReplyRequest,
  countPaidReplyTokens,
  generatePaidReply,
} from "./paid-reply-request.js";
import { resolveModel } from "./provider.js";

const original = process.env.GOOGLE_API_PROXY;
const originalAllowlist = process.env.GOOGLE_PROXY_ALLOWED_HOSTS;
afterEach(() => {
  if (original === undefined) delete process.env.GOOGLE_API_PROXY;
  else process.env.GOOGLE_API_PROXY = original;
  if (originalAllowlist === undefined) delete process.env.GOOGLE_PROXY_ALLOWED_HOSTS;
  else process.env.GOOGLE_PROXY_ALLOWED_HOSTS = originalAllowlist;
  vi.restoreAllMocks();
});

describe("Google proxy transport", () => {
  it("rejects unapproved workspace proxy destinations even after saving", async () => {
    delete process.env.GOOGLE_API_PROXY;
    delete process.env.GOOGLE_PROXY_ALLOWED_HOSTS;
    const workspace = "http://alice:private@proxy.example:8080";
    expect(isAllowedGoogleProxy(workspace)).toBe(false);
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(googleProxyFetch("https://example.invalid", undefined, workspace)).rejects.toThrow(
      "not approved",
    );
    expect(fetcher).not.toHaveBeenCalled();
    process.env.GOOGLE_PROXY_ALLOWED_HOSTS = "proxy.example:8080";
    expect(isAllowedGoogleProxy(workspace)).toBe(true);
    expect(isAllowedGoogleProxy("http://alice:private@other.example:8080")).toBe(false);
    process.env.GOOGLE_API_PROXY = "http://different:secret@fallback.example:3128";
    expect(isAllowedGoogleProxy("http://alice:private@fallback.example:3128")).toBe(true);
  });

  it("rejects URL syntax that points somewhere other than the approved host", () => {
    process.env.GOOGLE_PROXY_ALLOWED_HOSTS = "proxy.example:8080";
    const ambiguous = "http://127.0.0.1:8080\\@proxy.example:8080/..";
    expect(new URL(ambiguous).hostname).toBe("127.0.0.1");
    expect(googleProxyEnvSchema.safeParse(ambiguous).success).toBe(false);
    expect(isAllowedGoogleProxy(ambiguous)).toBe(false);
    expect(isAllowedGoogleProxy("http://proxy.example:08080")).toBe(true);
    expect(isAllowedGoogleProxy("http://proxy.example:80")).toBe(false);
  });

  it("keeps concurrent organizations on their own proxy dispatchers", async () => {
    process.env.GOOGLE_PROXY_ALLOWED_HOSTS = "one.example:8080,two.example:8080";
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("refused", { status: 400 }));
    const first = resolveModel({
      provider: "google",
      apiKey: "first-key",
      proxyUrl: "http://one.example:8080",
    });
    const second = resolveModel({
      provider: "google",
      apiKey: "second-key",
      proxyUrl: "http://two.example:8080",
    });
    await Promise.allSettled([
      generateText({ model: first, prompt: "one", maxRetries: 0 }),
      generateText({ model: second, prompt: "two", maxRetries: 0 }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const dispatchers = fetcher.mock.calls.map(
      ([, init]) => (init as RequestInit & { dispatcher?: unknown }).dispatcher,
    );
    expect(dispatchers[0]).toBeDefined();
    expect(dispatchers[1]).toBeDefined();
    expect(dispatchers[0]).not.toBe(dispatchers[1]);
  });

  it("accepts only an HTTP(S) proxy with an explicit port, without echoing credentials", () => {
    expect(googleProxyEnvSchema.parse("")).toBeUndefined();
    expect(googleProxyEnvSchema.parse("http://user:pass@proxy.example:8080")).toBeDefined();
    expect(googleProxyEnvSchema.parse("http://proxy.example:80")).toBeDefined();
    for (const url of [
      "socks5://proxy.example:1080",
      "http://proxy.example",
      "http://proxy.example:8080/path",
      "http://proxy.example:8080/?token=secret",
    ]) {
      const result = googleProxyEnvSchema.safeParse(url);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).not.toContain(url);
    }
  });

  it("uses Node's HTTP proxy dispatcher and sends proxy auth only to the proxy", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      seenUrl = request.url;
      seenAuth = request.headers["proxy-authorization"];
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("through-proxy");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("connect", (request, socket) => {
      seenUrl = request.url;
      seenAuth = request.headers["proxy-authorization"];
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\nthrough-proxy");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      process.env.GOOGLE_API_PROXY = `http://user:pass@127.0.0.1:${address.port}`;
      const response = await googleProxyFetch("http://upstream.invalid/v1beta/models");
      expect(await response.text()).toBe("through-proxy");
      expect(seenUrl).toMatch(/upstream\.invalid/);
      expect(seenAuth).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("keeps direct access when the proxy is unset", async () => {
    delete process.env.GOOGLE_API_PROXY;
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("direct"));
    expect(await (await googleProxyFetch("https://example.invalid/path")).text()).toBe("direct");
    expect(fetcher).toHaveBeenCalledWith("https://example.invalid/path", undefined);
  });

  it("routes SDK generation and embeddings, image REST, and paid-reply REST through one dispatcher", async () => {
    process.env.GOOGLE_API_PROXY = "http://user:pass@proxy.example:8080";
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(":countTokens")) return Response.json({ totalTokens: 10 });
      if (url.includes(":generateContent") && url.includes("gemini-3.1-flash-image"))
        return Response.json({ candidates: [] });
      return new Response("upstream refusal", { status: 400 });
    });

    const model = resolveModel({ provider: "google", apiKey: "test-key" });
    await expect(generateText({ model, prompt: "hello", maxRetries: 0 })).rejects.toThrow();
    await expect(embedKnowledgeText("test-key", "hello", "RETRIEVAL_QUERY")).rejects.toThrow();
    await new GeminiImageCaller().call("test-key", "draw a square");
    const request = buildPaidReplyRequest({ title: "Post", comments: ["Thought?"] });
    await countPaidReplyTokens(request, "test-key");
    await generatePaidReply(request, "test-key", async () => {});

    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toContain("generativelanguage.googleapis.com");
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
      expect(new Headers(init?.headers).has("proxy-authorization")).toBe(false);
    }
  });

  it("hides proxy transport failure details from run errors", async () => {
    process.env.GOOGLE_API_PROXY = "http://user:secret@proxy.example:8080";
    expect(redactSecrets(`proxy refused ${process.env.GOOGLE_API_PROXY}`)).toBe(
      "proxy refused [Google proxy]",
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("user:secret@proxy.example"));
    await expect(
      googleProxyFetch("https://generativelanguage.googleapis.com/v1beta/models"),
    ).rejects.toThrow("Gemini proxy transport failed");
    try {
      await generateText({
        model: resolveModel({ provider: "google", apiKey: "test-key" }),
        prompt: "hello",
        maxRetries: 0,
      });
      throw new Error("the proxy failure should stop generation");
    } catch (error) {
      const classified = classifyAiError(error);
      expect(classified).toBeInstanceOf(TransientError);
      expect(classified.message).not.toContain("secret");
    }
  });
});
