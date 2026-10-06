import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("normalized inbox database boundaries", () => {
  let connection: ReturnType<typeof createDb>;
  const org = `inbox-schema-${randomUUID()}`;
  let brand: string;
  let conversation: string;
  let message: string;
  function insertedId(result: { rows: { id: string }[] }) {
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (!row) throw new Error("Expected one fixture row");
    return row.id;
  }
  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string);
    const pool = connection.pool;
    await pool.query("insert into organization(id,name,slug) values($1,'Inbox schema',$1)", [org]);
    brand = insertedId(
      await pool.query<{ id: string }>(
        "insert into brands(org_id,name) values($1,'Inbox') returning id",
        [org],
      ),
    );
    conversation = insertedId(
      await pool.query<{ id: string }>(
        "insert into inbox_conversations(org_id,brand_id,publication_id,post_url,title,peer_id,root_id) values($1,$2,$3,'https://t.me/pubrick_test/9','Saved discussion',-1001234567890,42) returning id",
        [org, brand, randomUUID()],
      ),
    );
    message = insertedId(
      await pool.query<{ id: string }>(
        "insert into inbox_messages(org_id,brand_id,conversation_id,provider_message_id,body,published_at) values($1,$2,$3,51,'x',now()) returning id",
        [org, brand, conversation],
      ),
    );
  });
  afterAll(async () => {
    if (!connection) return;
    await connection.pool.query("delete from organization where id=$1", [org]);
    await connection.pool.end();
  });
  it("pins independent scoped identities, text and revision bounds against direct SQL", async () => {
    const pool = connection.pool;
    await expect(
      pool.query("update inbox_conversations set read_revision=1 where id=$1", [conversation]),
    ).rejects.toThrow("inbox_conversations_revisions_check");
    await expect(
      pool.query("update inbox_conversations set root_id=0 where id=$1", [conversation]),
    ).rejects.toThrow("inbox_conversations_target_check");
    await expect(
      pool.query("update inbox_conversations set has_older=true where id=$1", [conversation]),
    ).rejects.toThrow("inbox_conversations_window_check");
    await expect(
      pool.query("update inbox_messages set body='' where id=$1", [message]),
    ).rejects.toThrow("inbox_messages_text_check");
    await expect(
      pool.query("update inbox_messages set revision=-1 where id=$1", [message]),
    ).rejects.toThrow("inbox_messages_text_check");
    await expect(
      pool.query(
        "insert into inbox_messages(org_id,brand_id,conversation_id,provider_message_id,body,published_at) values($1,$2,$3,51,'Same provider identity',now())",
        [org, brand, conversation],
      ),
    ).rejects.toThrow("inbox_messages_provider_idx");
    const otherBrand = insertedId(
      await pool.query<{ id: string }>(
        "insert into brands(org_id,name) values($1,'Other') returning id",
        [org],
      ),
    );
    await expect(
      pool.query(
        "insert into inbox_messages(org_id,brand_id,conversation_id,provider_message_id,body,published_at) values($1,$2,$3,52,'Wrong scope',now())",
        [org, otherBrand, conversation],
      ),
    ).rejects.toThrow("inbox_messages_conversation_fk");
  });
  it("pins human reply receipts and unresolved uniqueness without provider sends", async () => {
    const pool = connection.pool;
    const id = randomUUID();
    const insert =
      "insert into inbox_replies(id,org_id,brand_id,conversation_id,message_id,actor_id,operation_key,sender_preview_id,message_revision,target_body,target_provider_message_id,message_fingerprint,body,sender_label,account_id,account_generation) values($1,$2,$3,$4,$5,'fixture',$6,$7,0,'x',51,$8,'Human answer','@fixture',7,$8)";
    await pool.query(insert, [
      id,
      org,
      brand,
      conversation,
      message,
      randomUUID(),
      randomUUID(),
      "a".repeat(64),
    ]);
    await expect(
      pool.query(insert, [
        randomUUID(),
        org,
        brand,
        conversation,
        message,
        randomUUID(),
        randomUUID(),
        "a".repeat(64),
      ]),
    ).rejects.toThrow("inbox_replies_unsettled_idx");
    await expect(
      pool.query("update inbox_replies set status='automatic',finished_at=now() where id=$1", [id]),
    ).rejects.toThrow("inbox_replies_status_check");
    await expect(pool.query("update inbox_replies set body='' where id=$1", [id])).rejects.toThrow(
      "inbox_replies_body_check",
    );
    await expect(
      pool.query("update inbox_replies set status='sent',finished_at=now() where id=$1", [id]),
    ).rejects.toThrow("inbox_replies_receipt_check");
    await expect(
      pool.query(
        "update inbox_replies set status='confirmed_not_sent',finished_at=now() where id=$1",
        [id],
      ),
    ).rejects.toThrow("inbox_replies_resolution_check");
    await expect(
      pool.query("update inbox_replies set resolved_by='fixture' where id=$1", [id]),
    ).rejects.toThrow("inbox_replies_resolution_check");
    await expect(
      pool.query("update inbox_replies set resolved_at=now() where id=$1", [id]),
    ).rejects.toThrow("inbox_replies_resolution_check");
    await expect(
      pool.query(
        "insert into inbox_sender_previews(org_id,brand_id,actor_id,session_id,account_generation,account_id,account_label,expires_at) values($1,$2,'fixture','fixture',$3,0,'@fixture',now())",
        [org, brand, "a".repeat(64)],
      ),
    ).rejects.toThrow("inbox_sender_previews_account_check");
    await pool.query(
      "update inbox_replies set status='sent',external_message_id=991,external_url='https://t.me/discussion_test/991',finished_at=now() where id=$1",
      [id],
    );
    expect(
      (await pool.query("select status,external_message_id from inbox_replies where id=$1", [id]))
        .rows[0],
    ).toEqual({ status: "sent", external_message_id: 991 });
  });
});
