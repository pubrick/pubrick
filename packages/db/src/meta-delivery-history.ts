import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

type Identity = string | SQLWrapper;

/** Reconstruct the exact latest-finished receipt the API requires before its appended decision. */
function noInterveningFinishedReceiptSql(uncertain: SQLWrapper, resolution: SQLWrapper) {
  return sql<boolean>`not exists (
    select 1 from publications preceding_decision
    where preceding_decision.org_id = ${uncertain}.org_id
      and preceding_decision.adaptation_id = ${uncertain}.adaptation_id
      and preceding_decision.status <> 'in_flight'
      and (preceding_decision.created_at, preceding_decision.id) > (${uncertain}.created_at, ${uncertain}.id)
      and (preceding_decision.created_at, preceding_decision.id) < (${resolution}.created_at, ${resolution}.id)
  )`;
}

/**
 * A retained unknown is settled only by a later human no-delivery decision for
 * its own attempt. Updating old evidence cannot undo that decision: receipt
 * created_at never moves. Timestamp ties deliberately remain unresolved.
 */
export function blockingPublicationHistorySql(
  orgId: Identity,
  adaptationId: Identity,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from publications publication_history
    where publication_history.org_id = ${orgId}
      and publication_history.adaptation_id = ${adaptationId}
      and (
        publication_history.status in ('published', 'in_flight')
        or (
          publication_history.status = 'unknown'
          and not exists (
            select 1 from publications human_resolution
            where human_resolution.org_id = publication_history.org_id
              and human_resolution.adaptation_id = publication_history.adaptation_id
              and human_resolution.attempt = publication_history.attempt
              and human_resolution.status = 'failed'
              and human_resolution.asserted_at is not null
              and human_resolution.created_at > publication_history.created_at
              and ${noInterveningFinishedReceiptSql(sql.identifier("publication_history"), sql.identifier("human_resolution"))}
          )
        )
      )
  )`;
}

/**
 * Historical final uncertainty may be kept after an explicit human resolution.
 * A linked final claim must be the exact receipt that decision settled. A
 * nonpublic preparation requires its separate explicit discard action instead.
 * Compose with blockingPublicationHistorySql: published/in-flight receipts
 * always block, and a later unknown is never hidden by an older human decision.
 */
export function blockingMetaStageHistorySql(
  orgId: Identity,
  adaptationId: Identity,
  excludeStageId?: Identity,
): SQL<boolean> {
  const settled = sql<boolean>`exists (
    select 1 from publications uncertain_final
    inner join publications final_resolution
      on final_resolution.org_id = uncertain_final.org_id
      and final_resolution.adaptation_id = uncertain_final.adaptation_id
      and final_resolution.attempt = uncertain_final.attempt
    where uncertain_final.org_id = meta_stage_history.org_id
      and uncertain_final.adaptation_id = meta_stage_history.adaptation_id
      and uncertain_final.attempt = meta_stage_history.attempt
      and uncertain_final.status = 'unknown'
      and (meta_stage_history.final_publication_id is null
        or uncertain_final.id = meta_stage_history.final_publication_id)
      and final_resolution.status = 'failed'
      and final_resolution.asserted_at is not null
      and final_resolution.created_at > uncertain_final.created_at
      and final_resolution.created_at > meta_stage_history.created_at
      and ${noInterveningFinishedReceiptSql(sql.identifier("uncertain_final"), sql.identifier("final_resolution"))}
      and not exists (
        select 1 from publications later_uncertainty
        where later_uncertainty.org_id = uncertain_final.org_id
          and later_uncertainty.adaptation_id = uncertain_final.adaptation_id
          and later_uncertainty.attempt = uncertain_final.attempt
          and later_uncertainty.status = 'unknown'
          and later_uncertainty.created_at >= final_resolution.created_at
      )
  )`;
  const knownFailedClaim = sql<boolean>`meta_stage_history.external_id is null
    and meta_stage_history.external_url is null
    and exists (
      select 1 from publications failed_final
      where failed_final.org_id = meta_stage_history.org_id
        and failed_final.adaptation_id = meta_stage_history.adaptation_id
        and failed_final.attempt = meta_stage_history.attempt
        and failed_final.id = meta_stage_history.final_publication_id
        and failed_final.status = 'failed'
        and failed_final.external_id is null and failed_final.external_url is null
    )`;
  return sql<boolean>`exists (
    select 1 from meta_publication_stages meta_stage_history
    where meta_stage_history.org_id = ${orgId}
      and meta_stage_history.adaptation_id = ${adaptationId}
      ${excludeStageId === undefined ? sql`` : sql`and meta_stage_history.id <> ${excludeStageId}`}
      and (
        meta_stage_history.phase in ('preparation_intent', 'waiting', 'preparation_unknown', 'published')
        or (
          meta_stage_history.phase in ('final_intent', 'final_unknown', 'published_without_receipt')
          and not ${settled}
        )
        or (
          meta_stage_history.phase in ('failed', 'cancelled')
          and (meta_stage_history.final_publication_id is not null
            or meta_stage_history.external_id is not null or meta_stage_history.external_url is not null)
          and not (${knownFailedClaim} or ${settled})
        )
      )
  )`;
}
