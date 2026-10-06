import {
  Long,
  networkMiddlewares,
  type RpcCallMiddleware,
  type RpcCallMiddlewareContext,
} from "@mtcute/core";
import { sendText } from "@mtcute/core/methods.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { replyToDiscussion } from "./discussion.js";

type SendArgs = [
  Parameters<typeof sendText>[1],
  Parameters<typeof sendText>[2],
  Parameters<typeof sendText>[3],
];
const captured = vi.hoisted(() => ({
  middlewares: undefined as RpcCallMiddleware[] | undefined,
  send: undefined as ((...args: SendArgs) => ReturnType<typeof sendText>) | undefined,
}));
// Preflight/connections are synthetic; production replyToDiscussion, public sendText and SDK middleware remain real.
vi.mock("@mtcute/node", () => ({
  TelegramClient: class {
    constructor(options: { middlewares?: RpcCallMiddleware[] }) {
      captured.middlewares = options.middlewares;
    }
    importSession = async () => undefined;
    destroy = async () => undefined;
    getDiscussionMessage = async () => root;
    getMessages = async () => [
      { id: 21, text: "x", replyToMessage: { id: 15, threadId: null }, editDate: null },
    ];
    getMe = async () => ({ id: 7, username: "writer" });
    sendText(...args: SendArgs) {
      if (!captured.send) throw new Error("Missing physical RPC fixture");
      return captured.send(...args);
    }
  },
}));
const root = {
  id: 15,
  chat: {
    id: -1001234567890,
    isLikelyUnavailable: false,
    inputPeer: { _: "inputPeerChannel" as const, channelId: 1234567890, accessHash: Long.ONE },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  captured.middlewares = undefined;
});
afterEach(() => vi.useRealTimers());

async function physicalSend(
  first: { errorCode: number; errorMessage: string },
  discussionSender = true,
) {
  const signal = new AbortController().signal;
  const calls: RpcCallMiddlewareContext[] = [];
  const boundary = async (ctx: RpcCallMiddlewareContext): Promise<unknown> => {
    calls.push(ctx);
    // A second, terminal client error lets an accidentally restored default retry finish deterministically.
    return {
      _: "mt_rpc_error",
      ...(calls.length === 1 ? first : { errorCode: 400, errorMessage: "FIXTURE_TERMINAL" }),
    };
  };
  const manager = {
    _log: { warn: vi.fn() },
    teardownSignal: new AbortController().signal,
  } as unknown as RpcCallMiddlewareContext["manager"];
  // This is the physical RPC boundary: no real connection/session, while sendText still builds its actual RPC/options.
  const client = {
    timers: { cancel: async () => undefined },
    call: async (
      request: RpcCallMiddlewareContext["request"],
      params: RpcCallMiddlewareContext["params"],
    ) => {
      const dispatch = (captured.middlewares ?? networkMiddlewares.basic()).reduceRight<
        (ctx: RpcCallMiddlewareContext) => Promise<unknown>
      >((next, middleware) => (ctx) => Promise.resolve(middleware(ctx, next)), boundary);
      await dispatch({ request, params, manager });
      throw new Error("fixture_rpc_refused");
    },
  } as unknown as Parameters<typeof sendText>[0];
  captured.send = (...args) => sendText(client, ...args);
  const started = Date.now();
  let completedAt = -1;
  const operation = discussionSender
    ? replyToDiscussion(
        { apiId: 123, apiHash: "synthetic", session: "synthetic-session" },
        {
          postUrl: "https://t.me/pubricktest/9",
          identity: { peerId: root.chat.id, rootId: root.id },
          message: {
            messageId: 21,
            body: "x",
            bodyTruncated: false,
            publishedAt: new Date(0),
            editedAt: null,
          },
          body: "Human reply",
          randomId: "123",
          expectedAccountId: 7,
          beforeSend: async (_account, create) => create(signal),
        },
      )
    : sendText(
        client,
        { _: "inputPeerChannel", channelId: 1234567890, accessHash: Long.ONE },
        { text: "Human reply", entities: [] },
        {
          replyTo: 21,
          threadId: 15,
          sendAs: "me",
          randomId: Long.fromString("123"),
          abortSignal: signal,
        },
      );
  const attempted = operation.catch((error: unknown) => {
    completedAt = Date.now() - started;
    return error;
  });
  await vi.advanceTimersByTimeAsync(1100);
  expect(await attempted).toMatchObject({
    message: discussionSender ? "unavailable" : "fixture_rpc_refused",
  });
  expect(calls.every((ctx) => ctx.request._ === "messages.sendMessage")).toBe(true);
  expect(calls[0]?.params?.abortSignal).toBeInstanceOf(AbortSignal);
  if (!discussionSender) expect(calls[0]?.params?.abortSignal).toBe(signal);
  expect(calls[0]?.request).toMatchObject({
    message: "Human reply",
    randomId: Long.fromString("123"),
    sendAs: { _: "inputPeerSelf" },
    replyTo: { _: "inputReplyToMessage", replyToMsgId: 21, topMsgId: 15 },
  });
  return { calls: calls.length, completedAt };
}

describe("maintained Telegram sender middleware", () => {
  it.each([
    { errorCode: 500, errorMessage: "INTERNAL" },
    { errorCode: 500, errorMessage: "WORKER_BUSY_TOO_LONG_RETRY" },
    { errorCode: 420, errorMessage: "FLOOD_WAIT_1" },
  ])(
    "never retries or sleeps after $errorMessage at the actual sendMessage RPC boundary",
    async (first) => {
      const evidence = await physicalSend(first);
      expect(evidence).toEqual({ calls: 1, completedAt: 0 });
    },
  );
  it("preserves default reader behavior and proves this fixture observes a physical SDK retry", async () => {
    createClient({ apiId: 123, apiHash: "synthetic" });
    expect(captured.middlewares).toBeUndefined();
    expect(await physicalSend({ errorCode: 500, errorMessage: "INTERNAL" }, false)).toEqual({
      calls: 2,
      completedAt: 1000,
    });
  });
});
