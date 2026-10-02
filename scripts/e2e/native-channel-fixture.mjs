import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const NATIVE_BOT_TOKEN = "74001:pubrick_disposable_channel_only";
export const NATIVE_CHAT_ID = "-1001234567890";
export const NATIVE_TEXT = "A reviewed post delivered only to the local Telegram fixture.";

/** Owns one loopback provider; never forwards requests to a real platform. */
export async function startNativeChannelFixture() {
  const secret = randomBytes(32).toString("hex");
  const calls = [];
  const unexpected = [];
  let pending;
  let released = false;
  const reply = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const sent = () => ({
    ok: true,
    result: { message_id: 88, chat: { id: Number(NATIVE_CHAT_ID) } },
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/fixture/")) {
        if (request.headers.authorization !== `Bearer ${secret}`) {
          reply(response, 401, {});
          return;
        }
        if (request.method === "GET" && request.url === "/fixture/state") {
          reply(response, 200, { calls, unexpected, pending: Boolean(pending) });
          return;
        }
        if (request.method === "POST" && request.url === "/fixture/release") {
          released = true;
          if (pending) {
            clearTimeout(pending.timer);
            reply(pending.response, 200, sent());
            pending = undefined;
          }
          reply(response, 200, {});
          return;
        }
        reply(response, 404, {});
        return;
      }
      const method = request.url?.slice(`/bot${NATIVE_BOT_TOKEN}/`.length);
      if (
        request.method !== "POST" ||
        !request.url?.startsWith(`/bot${NATIVE_BOT_TOKEN}/`) ||
        !["getMe", "getChat", "getChatMember", "sendMessage"].includes(method)
      )
        throw new Error("unexpected_route");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) throw new Error("body_limit");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (method !== "getMe" && body.chat_id !== NATIVE_CHAT_ID) throw new Error("unexpected_chat");
      if (method === "getChatMember" && body.user_id !== 74001) throw new Error("unexpected_bot");
      if (method === "sendMessage" && (body.text !== NATIVE_TEXT || calls.includes("sendMessage")))
        throw new Error("unexpected_publication");
      calls.push(method);
      const results = {
        getMe: { id: 74001, username: "browser_bot" },
        getChat: { id: Number(NATIVE_CHAT_ID), type: "channel", title: "Browser channel" },
        getChatMember: { status: "administrator", can_post_messages: true },
      };
      if (method === "sendMessage") {
        if (released) reply(response, 200, sent());
        else {
          const timer = setTimeout(() => {
            unexpected.push("publication_not_released");
            reply(response, 504, {});
            pending = undefined;
          }, 20_000);
          pending = { response, timer };
        }
      } else reply(response, 200, { ok: true, result: results[method] });
    } catch {
      // Record a failure even if the application catches the refusal.
      unexpected.push("refused_request");
      reply(response, 400, { ok: false, error_code: 400, description: "Fixture refused request" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    secret,
    assertComplete() {
      if (
        unexpected.length ||
        pending ||
        JSON.stringify(calls) !==
          JSON.stringify(["getMe", "getChat", "getChatMember", "sendMessage"])
      )
        throw new Error("Native channel fixture did not complete exactly one verified publication");
    },
    async close() {
      if (pending) {
        clearTimeout(pending.timer);
        pending.response.destroy();
        pending = undefined;
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
