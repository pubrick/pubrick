import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NATIVE_BOT_TOKEN,
  NATIVE_CHAT_ID,
  NATIVE_TEXT,
  startNativeChannelFixture,
} from "./e2e/native-channel-fixture.mjs";

test("native fixture verifies credentials, latches one local send and checks completion", async () => {
  const fixture = await startNativeChannelFixture();
  const headers = { authorization: `Bearer ${fixture.secret}` };
  const call = (method, body = {}) =>
    fetch(`${fixture.origin}/bot${NATIVE_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  try {
    assert.throws(() => fixture.assertComplete());
    assert.equal((await fetch(`${fixture.origin}/fixture/state`)).status, 401);
    assert.deepEqual((await (await call("getMe")).json()).result, {
      id: 74001,
      username: "browser_bot",
    });
    assert.equal((await call("getChat", { chat_id: NATIVE_CHAT_ID })).status, 200);
    assert.equal(
      (await call("getChatMember", { chat_id: NATIVE_CHAT_ID, user_id: 74001 })).status,
      200,
    );
    const send = call("sendMessage", { chat_id: NATIVE_CHAT_ID, text: NATIVE_TEXT });
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(`${fixture.origin}/fixture/state`, { headers })).json();
      if (state.pending) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state.pending, true);
    assert.throws(() => fixture.assertComplete());
    assert.equal(
      (await fetch(`${fixture.origin}/fixture/release`, { method: "POST", headers })).status,
      200,
    );
    assert.equal((await (await send).json()).result.message_id, 88);
    fixture.assertComplete();
    assert.equal(
      (await call("sendMessage", { chat_id: NATIVE_CHAT_ID, text: NATIVE_TEXT })).status,
      400,
    );
    assert.throws(() => fixture.assertComplete());
  } finally {
    await fixture.close();
  }
});

test("native fixture refuses foreign token, chat, bot, body and transport without forwarding", async () => {
  for (const [path, method, body] of [
    ["/botforeign/getMe", "POST", {}],
    [`/bot${NATIVE_BOT_TOKEN}/getMe`, "GET", undefined],
    [`/bot${NATIVE_BOT_TOKEN}/getChat`, "POST", { chat_id: "foreign" }],
    [`/bot${NATIVE_BOT_TOKEN}/getChatMember`, "POST", { chat_id: NATIVE_CHAT_ID, user_id: 42 }],
    [`/bot${NATIVE_BOT_TOKEN}/sendMessage`, "POST", { chat_id: NATIVE_CHAT_ID, text: "foreign" }],
    [`/bot${NATIVE_BOT_TOKEN}/getMe`, "POST", "x".repeat(8193)],
  ]) {
    const fixture = await startNativeChannelFixture();
    try {
      const response = await fetch(`${fixture.origin}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 400);
      const state = await (
        await fetch(`${fixture.origin}/fixture/state`, {
          headers: { authorization: `Bearer ${fixture.secret}` },
        })
      ).json();
      assert.deepEqual(state.calls, []);
      assert.deepEqual(state.unexpected, ["refused_request"]);
      assert.throws(() => fixture.assertComplete());
    } finally {
      await fixture.close();
    }
  }
});
