import type { NotificationEvent } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import type { db } from "../db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Called inside the transaction that commits the event. No provider I/O here. */
export async function enqueueNotification(
  tx: Tx,
  orgId: string,
  event: NotificationEvent,
  subjectId: string,
  targetId: string,
  attempt = 0,
): Promise<void> {
  await tx.execute(sql`
    insert into notification_events (org_id, event, subject_id, target_id, attempt)
    select ${orgId}, ${event}, ${subjectId}::uuid, ${targetId}::uuid, ${attempt}
      from notification_settings s
     where s.org_id = ${orgId}
       and s.enabled = true
       and s.credentials_encrypted is not null
       and ((${event === "draft_ready"} and s.draft_ready)
         or (${event !== "draft_ready"} and s.delivery_problem))
    on conflict (org_id, event, subject_id, attempt) do nothing
  `);
}
