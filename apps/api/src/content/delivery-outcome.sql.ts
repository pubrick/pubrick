import type { DeliveryOutcome } from "@pubrick/shared";
import { sql } from "drizzle-orm";

/**
 * The current delivery verdict: only a failed adaptation consults its last finished receipt.
 * Keep the outer table qualification literal. Drizzle removes it from an
 * interpolated column inside a SELECT expression, and the inner receipt's `id`
 * would then shadow `adaptations.id` and silently turn unknown into failed.
 */
export const deliveryOutcomeSql = sql<DeliveryOutcome>`(
  case
    when adaptations.status = 'failed' then coalesce((
      select case
        when p.status = 'unknown' and p.partial_followup_text is not null then 'partial'
        when p.status = 'unknown' then 'unknown'
        else null
      end
      from publications p
      where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
      order by p.created_at desc
      limit 1
    ), adaptations.status)
    else adaptations.status
  end
)`;
