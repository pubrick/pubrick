import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { request as tlsRequest } from "node:https";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const SYNTHETIC_BOT_ID = 74001;
export const SYNTHETIC_HUMAN_ID = 74002;
export const SYNTHETIC_CHAT_ID = -10042;
export const SYNTHETIC_BOT_TOKEN = "74001:pubrick_disposable_telegram_only";
const publicOrigin = "https://127.0.0.1:31302";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A loopback-only provider and fixture control plane. Production code is unmodified. */
export async function startTelegramBotFixture({ marker, ca, pool, databaseUrl }) {
  if (
    !/^telegram-browser-[a-f0-9-]{36}$/.test(marker) ||
    new URL(databaseUrl).hostname !== "127.0.0.1"
  )
    throw new Error("Owned Telegram disposable fixture required");
  const requireWorker = createRequire(resolve("apps/worker/package.json"));
  const { PgBoss } = await import(requireWorker.resolve("pg-boss"));
  const boss = new PgBoss({ connectionString: databaseUrl, supervise: false, schedule: false });
  boss.on("error", () => {
    unexpected.push("queue_error");
  });
  let webhook = null;
  let nextMessageId = 100;
  let nextUpdateId = 1000;
  const messages = [];
  const updates = new Map();
  const calls = [];
  const unexpected = [];
  await boss.start();
  await boss.createQueue("notification-scan");
  const deliver = async (update) => {
    if (!webhook) throw new Error("No verified webhook installed");
    const destination = new URL(webhook.url);
    if (
      destination.origin !== publicOrigin ||
      !/^\/api\/telegram\/webhook\/[A-Za-z0-9_-]{43}$/.test(destination.pathname)
    )
      throw new Error("Fixture refuses a foreign webhook destination");
    const body = Buffer.from(JSON.stringify(update));
    updates.set(update.update_id, update);
    return new Promise((accept, reject) => {
      const request = tlsRequest(
        destination,
        {
          method: "POST",
          ca,
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            "x-telegram-bot-api-secret-token": webhook.secret,
          },
          timeout: 10_000,
        },
        (response) => {
          response.resume();
          response.on("end", () =>
            accept({ status: response.statusCode, updateId: update.update_id }),
          );
        },
      );
      request.on("timeout", () => request.destroy(new Error("Fixture callback deadline")));
      request.on("error", reject);
      request.end(body);
    });
  };
  const seedDraft = async ({ orgId, brandId, channelId, scenario }) => {
    if (
      ![orgId, brandId, channelId].every((id) => typeof id === "string") ||
      !uuid.test(brandId) ||
      !uuid.test(channelId) ||
      !["reject", "stale", "unlink"].includes(scenario)
    )
      throw new Error("Invalid owned draft fixture");
    const client = await pool.connect();
    const itemId = randomUUID();
    const runId = randomUUID();
    const adaptationId = randomUUID();
    const title = `Telegram ${scenario} ${marker}`;
    try {
      await client.query("BEGIN");
      const parents = await client.query(
        `SELECT brands.id FROM organization JOIN brands ON brands.org_id=organization.id
        JOIN channels ON channels.org_id=organization.id AND channels.brand_id=brands.id
        WHERE organization.id=$1 AND brands.id=$2 AND channels.id=$3 FOR KEY SHARE OF organization, brands, channels`,
        [orgId, brandId, channelId],
      );
      if (parents.rows.length !== 1) throw new Error("Fixture resource parents not owned");
      await client.query(
        `INSERT INTO content_items (id,org_id,brand_id,title,body,status,is_safe_to_delete)
        VALUES ($1,$2,$3,$4,$5,'draft',true)`,
        [
          itemId,
          orgId,
          brandId,
          title,
          `Synthetic ${scenario} draft. No model and no publication are allowed.`,
        ],
      );
      await client.query(
        `INSERT INTO adaptations (id,org_id,content_item_id,channel_id,status,body)
        VALUES ($1,$2,$3,$4,'pending',$5)`,
        [adaptationId, orgId, itemId, channelId, `Synthetic ${scenario} adaptation.`],
      );
      await client.query(
        `INSERT INTO pipeline_runs (id,org_id,brand_id,content_item_id,status,input)
        VALUES ($1,$2,$3,$4,'succeeded',$5::jsonb)`,
        [
          runId,
          orgId,
          brandId,
          itemId,
          JSON.stringify({
            kind: "brief",
            text: `Synthetic fixture ${marker}`,
            channelIds: [channelId],
          }),
        ],
      );
      await client.query(
        `INSERT INTO notification_events (org_id,event,subject_id,target_id) VALUES ($1,'draft_ready',$2,$3)`,
        [orgId, runId, itemId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // The real compiled worker handles this pg-boss job. No service is called directly.
    await boss.send("notification-scan", {});
    return { itemId, title, adaptationId, runId };
  };
  const server = createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 65536) {
          reply(413, { error: "fixture_body_limit" });
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      if (request.url?.startsWith("/fixture/")) {
        if (request.headers["x-pubrick-disposable-marker"] !== marker) {
          reply(401, {});
          return;
        }
        switch (request.url) {
          case "/fixture/state":
            reply(200, { messages, calls, unexpected, installed: Boolean(webhook) });
            return;
          case "/fixture/draft":
            reply(200, await seedDraft(body));
            return;
          case "/fixture/start": {
            if (!/^[A-Za-z0-9_-]{43}$/.test(body.code ?? ""))
              throw new Error("Invalid start fixture");
            const update = {
              update_id: nextUpdateId++,
              message: {
                message_id: nextMessageId++,
                text: `/start ${body.code}`,
                from: { id: SYNTHETIC_HUMAN_ID, is_bot: false, first_name: "<Synthetic Human>" },
                chat: { id: SYNTHETIC_HUMAN_ID, type: "private" },
              },
            };
            reply(200, await deliver(update));
            return;
          }
          case "/fixture/callback": {
            const message = messages.find((entry) => entry.messageId === body.messageId);
            const button = message?.body.reply_markup?.inline_keyboard
              ?.flat()
              .find((entry) => entry.callback_data?.startsWith(`${body.operation}:`));
            if (!message || !button || !["ir", "cr", "ca"].includes(body.operation))
              throw new Error("Unknown observed callback fixture");
            const update = {
              update_id: nextUpdateId++,
              callback_query: {
                id: `fixture-query-${nextUpdateId}`,
                data: button.callback_data,
                from: { id: SYNTHETIC_HUMAN_ID, is_bot: false, first_name: "Synthetic Human" },
                message: {
                  message_id: message.messageId,
                  date: Math.floor(Date.now() / 1000),
                  from: { id: SYNTHETIC_BOT_ID, is_bot: true },
                  chat: { id: message.chatId, type: message.chatId < 0 ? "supergroup" : "private" },
                },
              },
            };
            reply(200, await deliver(update));
            return;
          }
          case "/fixture/replay": {
            const update = updates.get(body.updateId);
            if (!update) throw new Error("Unknown accepted update fixture");
            reply(200, await deliver(update));
            return;
          }
          default:
            reply(404, {});
            return;
        }
      }
      const method = new RegExp(`^/bot${SYNTHETIC_BOT_TOKEN}/([A-Za-z]+)$`).exec(
        request.url ?? "",
      )?.[1];
      if (
        request.method !== "POST" ||
        !method ||
        ![
          "getMe",
          "getWebhookInfo",
          "setWebhook",
          "deleteWebhook",
          "sendMessage",
          "answerCallbackQuery",
        ].includes(method)
      ) {
        unexpected.push("unexpected_provider_operation");
        reply(400, { ok: false, error_code: 400 });
        return;
      }
      calls.push({ method });
      if (method === "getMe")
        reply(200, {
          ok: true,
          result: { id: SYNTHETIC_BOT_ID, is_bot: true, username: "PubrickSyntheticBot" },
        });
      else if (method === "getWebhookInfo")
        reply(200, {
          ok: true,
          result: {
            url: webhook?.url ?? "",
            has_custom_certificate: false,
            pending_update_count: 0,
          },
        });
      else if (method === "setWebhook") {
        const url = new URL(body.url);
        if (
          url.origin !== publicOrigin ||
          !/^\/api\/telegram\/webhook\/[A-Za-z0-9_-]{43}$/.test(url.pathname) ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(body.secret_token) ||
          JSON.stringify(body.allowed_updates) !== '["message","callback_query"]' ||
          body.drop_pending_updates !== false
        )
          throw new Error("Unsafe fixture webhook installation");
        webhook = { url: body.url, secret: body.secret_token };
        reply(200, { ok: true, result: true });
      } else if (method === "deleteWebhook") {
        webhook = null;
        reply(200, { ok: true, result: true });
      } else if (method === "answerCallbackQuery") reply(200, { ok: true, result: true });
      else {
        const chatId = Number(body.chat_id);
        if (
          ![SYNTHETIC_CHAT_ID, SYNTHETIC_HUMAN_ID].includes(chatId) ||
          typeof body.text !== "string" ||
          !(
            body.text.startsWith("Draft ready for review") ||
            body.text.startsWith("Confirm rejection of this draft")
          )
        ) {
          unexpected.push("publication_or_unexpected_send");
          reply(400, { ok: false, error_code: 400 });
          return;
        }
        const messageId = nextMessageId++;
        messages.push({ messageId, chatId, body });
        reply(200, {
          ok: true,
          result: {
            message_id: messageId,
            from: { id: SYNTHETIC_BOT_ID, is_bot: true },
            chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
          },
        });
      }
    } catch {
      unexpected.push("fixture_request_failed");
      reply(500, { error: "fixture_request_failed" });
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(31303, "127.0.0.1", accept);
  });
  return {
    snapshot: () => ({ messages, calls, unexpected }),
    close: async () => {
      server.closeAllConnections();
      await new Promise((accept) => server.close(accept));
      await boss.stop({ graceful: true });
    },
  };
}
