import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type AdaptationUpdate,
  allSentencesAi,
  type ContentCreate,
  type ContentUpdate,
  type DeliveryOutcome,
  isSameText,
} from "@pubrick/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const ITEM_COLUMNS = {
  id: schema.contentItems.id,
  brandId: schema.contentItems.brandId,
  title: schema.contentItems.title,
  body: schema.contentItems.body,
  status: schema.contentItems.status,
  /**
   * Who wrote this text. Exposed because the origin badge is DERIVED, not
   * stored (spec §6): `human` reads human-written, `ai` reads AI-drafted or
   * human-edited depending on `bodyIsAiVerbatim` — whether every sentence of
   * the body is still one the model wrote.
   */
  origin: schema.contentItems.origin,
  createdAt: schema.contentItems.createdAt,
  updatedAt: schema.contentItems.updatedAt,
};

/** Validated (not `as never`-cast) against this at the API boundary in `list()`. */
type ContentStatusValue = (typeof schema.CONTENT_STATUSES)[number];

type AdaptationStatusValue = (typeof schema.ADAPTATION_STATUSES)[number];

/** `full` or `fragment` — whether a version row is a whole body or a refine's. */
type VersionScopeValue = (typeof schema.VERSION_SCOPES)[number];

/**
 * Item statuses in which the text is still the author's to change.
 *
 * Approval PINS the content. The worker reads `content_items.body` (or the
 * adaptation's override) at EXECUTION time, not at approval time, so an edit
 * accepted after an approval does not touch a copy — it replaces the reviewed
 * text of a post that is already queued or scheduled with text nobody reviewed.
 * Editing is therefore refused outright once the item leaves this set, rather
 * than silently resetting it to `draft`: taking an approval back is a decision,
 * and the reviewer makes it explicitly (reject, edit, approve again).
 *
 * `failed` IS in the set, and deliberately so. Nothing is pinned by it:
 * `recomputeItemStatus` only writes `failed` once EVERY adaptation has failed,
 * so no delivery is outstanding, no post is live, and no approval is being
 * revoked — and a late dead-letter delivery cannot resurrect one either, since
 * `markExhausted` acts only on an adaptation still in `publishing`. Excluding
 * it was also incoherent with `approve`, which re-targets `failed` adaptations:
 * the same failed text could be re-sent in one click but not CORRECTED without
 * a reject first, even though the most common permanent failure IS the content
 * (Telegram 400: too long, bad entities). Fixing the text is the entire point
 * of that screen.
 *
 * `as const satisfies` rather than a `readonly ContentStatusValue[]`
 * annotation: both make a typo a compile error, but this one also keeps the
 * literal member types, which is what lets `PINNED_ITEM_MESSAGE` below be
 * exhaustive by construction.
 */
const EDITABLE_ITEM_STATUSES = [
  "draft",
  "rejected",
  "failed",
] as const satisfies readonly ContentStatusValue[];

type EditableItemStatus = (typeof EDITABLE_ITEM_STATUSES)[number];
/** The complement: every status in which the text is pinned. */
type PinnedItemStatus = Exclude<ContentStatusValue, EditableItemStatus>;

/**
 * The 409 body, in the words of the status the user is actually looking at.
 *
 * A single sentence could not tell the truth here: "Approved content cannot be
 * edited" is a lie about an item the UI labels "Published", and was one about
 * "Failed" until that became editable. Keying the message off the status keeps
 * the two in step, and typing the record over `PinnedItemStatus` means adding a
 * status to `CONTENT_STATUSES` without deciding what it means for editing is a
 * compile error here rather than a confident wrong sentence in the UI.
 */
const PINNED_ITEM_MESSAGE: Record<PinnedItemStatus, string> = {
  approved: "Approved content cannot be edited; reject it first",
  published: "This content has already been published and can no longer be edited",
};

/**
 * Adaptation statuses with no delivery in flight, so an override is still safe
 * to change. Same shape, same reasoning as the item set above.
 */
const EDITABLE_ADAPTATION_STATUSES = [
  "pending",
  "failed",
] as const satisfies readonly AdaptationStatusValue[];

type EditableAdaptationStatus = (typeof EDITABLE_ADAPTATION_STATUSES)[number];
type PinnedAdaptationStatus = Exclude<AdaptationStatusValue, EditableAdaptationStatus>;

/** Per-status 409 body for one channel's override — exhaustive, as above. */
const PINNED_ADAPTATION_MESSAGE: Record<PinnedAdaptationStatus, string> = {
  scheduled: "A scheduled post cannot be edited; reject the content first",
  queued: "A post already queued for publishing cannot be edited; reject the content first",
  publishing: "A post that is being published right now cannot be edited; reject the content first",
  published: "This channel's post has already been published and can no longer be edited",
};

/**
 * The 409 for the product's headline promise: nothing publishes that no human
 * opened or touched.
 *
 * Written for the operator, not the log: it names the things that clear the
 * refusal, because each is one act away and none is discoverable from
 * "409 Conflict". The web app effectively never sees this — its item page fires
 * `POST /:id/opened` on render — which is exactly why it must read well for the
 * callers that will: the public API, the MCP server, and a script.
 *
 * TWO sentences, because one could not be true of both shapes the widened gate
 * refuses (`requireHumanInvolvement`, clause 1) — the same reason
 * `PINNED_ITEM_MESSAGE` above is keyed by status. Editing clears the refusal
 * only where the body has a COMPLETE `ai` version to be judged against: with
 * none, `allSentencesAi` takes its missing-evidence branch and answers "still
 * the model's" for every possible body, so a caller told to edit could rewrite
 * every word and be refused again, forever. That is not a corner: it is the
 * ordinary shape of a hand-typed draft whose CHANNEL text a refine verb wrote,
 * and it is exactly the case that the widening makes reachable.
 *
 * The second sentence promises only what always works — opening it. Editing one
 * channel's override does clear this shape too, but only when that channel has
 * a complete `ai` version of its own, so the message does not offer it.
 */
const UNREAD_AI_DRAFT_MESSAGE =
  "No one has read this AI-written draft yet; open it, or edit it, before approving";

/** The same refusal where editing cannot lift it — see above. */
const UNREAD_AI_DRAFT_OPEN_ONLY_MESSAGE =
  "No one has read the AI-written text in this content yet; open it before approving — " +
  "editing the body cannot clear this refusal, because no complete AI version of the body " +
  "was ever recorded";

function isEditableItemStatus(status: ContentStatusValue): status is EditableItemStatus {
  return EDITABLE_ITEM_STATUSES.some((editable) => editable === status);
}

function isEditableAdaptationStatus(
  status: AdaptationStatusValue,
): status is EditableAdaptationStatus {
  return EDITABLE_ADAPTATION_STATUSES.some((editable) => editable === status);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ADAPTATION_COLUMNS = {
  id: schema.adaptations.id,
  contentItemId: schema.adaptations.contentItemId,
  channelId: schema.adaptations.channelId,
  body: schema.adaptations.body,
  status: schema.adaptations.status,
  /**
   * Tracked per channel because the adaptation body is what actually reaches
   * the platform: an item a human wrote can still carry AI-adapted channel
   * bodies, which is the "AI-adapted" badge in spec §6.
   */
  origin: schema.adaptations.origin,
  scheduledAt: schema.adaptations.scheduledAt,
  attemptCount: schema.adaptations.attemptCount,
  lastError: schema.adaptations.lastError,
  /**
   * The worker logs one `publications` row per delivery attempt
   * (apps/worker/src/publish/publish.repository.ts markPublished/markFailed)
   * but never writes back to the adaptation row itself, so the link the web
   * UI needs to render "published -> link" has to be pulled in here. A
   * correlated subquery on the most recent `published` publication for this
   * adaptation (verified to work inside both SELECT and RETURNING via a
   * standalone psql check). Plain SQL text rather than embedded table/column
   * objects in the template, since drizzle's `sql` tag interpolation of a
   * bare Table for a subquery FROM isn't exercised anywhere else in this
   * codebase — the literal column/table names here are the actual db names
   * from packages/db/src/schema/content-items.ts, not TS property names.
   *
   * Scoped to `published` and deliberately NOT widened to the `unknown`
   * receipts `deliveryOutcome` below reads: an unknown delivery has no link and
   * cannot have one — the worker writes `external_url = null` on every one of
   * them, because the answer that would have carried the id never arrived. That
   * absence IS the outcome, and the screens say where the post may have gone by
   * naming the CHANNEL, which they know without asking this subquery.
   */
  externalUrl: sql<string | null>`(
    select external_url from publications
    where adaptation_id = adaptations.id and status = 'published'
    order by created_at desc
    limit 1
  )`,
  /**
   * WHAT HAPPENED TO THIS CHANNEL'S POST — `DeliveryOutcome`, the field the web
   * labels a delivery from. Its seven values are documented on the union in
   * `@pubrick/shared`; this is where the seventh is computed.
   *
   * The adaptation column has six: `failed` is its only
   * terminal-and-not-published state, so a send whose answer never came back —
   * the post may be live in the channel, nothing here can tell — is stored as
   * `failed` too. The distinction lives on the `publications` receipt the
   * worker writes per attempt, whose status is `unknown` for exactly that
   * ending (`PublishService.recordUnknownOutcome`, and `sweepAbandoned` for an
   * attempt that died holding its in-flight claim). Rounding it back to
   * `failed` invites the re-approval that posts a SECOND copy, which is the
   * whole reason the distinction exists.
   *
   * Computed HERE, in SQL, rather than in either browser screen:
   *
   * - It is one expression in `ADAPTATION_COLUMNS`, so every reader gets it —
   *   the list, the item, and `updateAdaptation`'s RETURNING — and a future
   *   one cannot forget to apply it. (The correlated subquery works in both
   *   SELECT and RETURNING; `externalUrl` above relies on the same.)
   * - The queue and the item screen ask the same question, and a verdict the
   *   server computes is a verdict they cannot answer differently — the reason
   *   `bodyIsAiVerbatim` is a server-computed boolean a few fields up.
   * - Before it, the only trace of an unknown outcome that reached a browser
   *   was the ENGLISH SENTENCE the worker happens to prefix `last_error` with,
   *   which the web recognised by `startsWith`. A reworded log line turned
   *   every unknown delivery back into a plain red failure, silently.
   *
   * BOTH HALVES OF THE CONDITION ARE LOAD-BEARING. `status = 'failed'` is what
   * scopes the receipt to the delivery being described: an unknown attempt
   * leaves its receipt behind for ever, and a human who checked the channel and
   * approved again has an adaptation that is `queued` — reading the old receipt
   * then would label a send that is in flight right now with the verdict of the
   * one before it. And `status <> 'in_flight'` picks the last FINISHED attempt:
   * a claim is written before the platform is called, so it is a record that
   * someone is sending, not a record of how it ended.
   */
  deliveryOutcome: sql<DeliveryOutcome>`(
    case
      when adaptations.status = 'failed' and (
        select p.status from publications p
        where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
        order by p.created_at desc
        limit 1
      ) = 'unknown'
      then 'unknown'
      else adaptations.status
    end
  )`,
};

/**
 * The columns `get` needs to answer "which sentences are still the AI's" —
 * which level a version belongs to, its text, and whether that text is a whole
 * body or a refine's fragment. Nothing wider: the caller dims sentences, and a
 * version's title, run, author and timestamp would be payload nobody reads and
 * an allowlist nobody could shrink again.
 *
 * `scope` is read but NOT returned. It answers the badge's deletion clause on
 * the server (`collectAiEvidence`); the lens dims a sentence that matches any
 * `ai` row, and a fragment is dimmable text like any other.
 */
const AI_VERSION_COLUMNS = {
  adaptationId: schema.contentVersions.adaptationId,
  body: schema.contentVersions.body,
  scope: schema.contentVersions.scope,
};

type AiVersionRow = { adaptationId: string | null; body: string };

/**
 * The evidence `allSentencesAi` judges ONE level against: every `ai` body, for
 * the mask, and the first `scope = 'full'` body, for the deletion clause.
 *
 * The two are separate arguments there for a reason worth restating at every
 * call site, because getting it wrong is silent: `bodies[0]` is NOT the full
 * row. Nothing makes a level's `full` row its oldest one — a fragment sorts
 * first at any level whose full row arrives later, a re-generation after a
 * refine being the obvious way — and counting a body's sentences against a
 * one-sentence fragment makes "at least as many sentences as the model wrote"
 * true for everything: the deletion clause becomes a no-op and every deletion
 * reads as untouched AI.
 */
type AiEvidence = { readonly bodies: readonly string[]; readonly firstFullBody?: string };

/**
 * No rows at all: the fail-safe shape, spelled once and shared by every caller
 * that missed the map — hence `readonly`, so no consumer can push a body into
 * the value the next one reads.
 */
const NO_AI_EVIDENCE: AiEvidence = { bodies: [], firstFullBody: undefined };

/**
 * Collects that evidence per level, from rows already ordered oldest-first.
 *
 * The order is the caller's job and every caller does it the same way
 * (`created_at, id`), because "first" is only meaningful under one — see
 * `aiVersionRows` for why the tiebreak is load-bearing. This function cannot
 * check that it was given one, which is why it is the only place that decides
 * what "first `full`" means: the gate, the item response and the queue all read
 * it from here rather than each picking a row for itself.
 */
function collectAiEvidence<K, R extends { body: string; scope: VersionScopeValue }>(
  rows: readonly R[],
  levelOf: (row: R) => K,
): Map<K, AiEvidence> {
  const byLevel = new Map<K, { bodies: string[]; firstFullBody?: string }>();
  for (const row of rows) {
    const level = levelOf(row);
    const evidence = byLevel.get(level) ?? { bodies: [], firstFullBody: undefined };
    evidence.bodies.push(row.body);
    if (row.scope === "full" && evidence.firstFullBody === undefined) {
      evidence.firstFullBody = row.body;
    }
    byLevel.set(level, evidence);
  }
  return byLevel;
}

/**
 * The body a human save should be remembered by, or `null` for a save that is
 * not a new version of anything.
 *
 * Three ways to write no row, and each is a real request the product makes
 * constantly rather than a corner:
 *
 * - `undefined` — the field is not in this PATCH at all. A title-only edit
 *   leaves the body exactly as it was, and a version of an unchanged body is
 *   history of an edit nobody made.
 * - `null` — a cleared per-channel override. It removes text and writes none,
 *   and `content_versions.body` is `NOT NULL`: there is no row shape for "no
 *   body", and inventing one (the empty string, or the item body it now falls
 *   back to) would file text the author did not write as text they did.
 * - The same text — the Save button pressed twice, or a reflow. `isSameText`,
 *   and NOT `normalizeForComparison` on the whole body, which is what this used
 *   to be: that comparison collapses every whitespace run, so it cannot see the
 *   newline the splitter treats as a sentence boundary, while the gate and the
 *   badge (`allSentencesAi`) split first and can see nothing else. Swapping one
 *   U+000A for a space in line-structured copy was therefore invisible here and
 *   decisive there — the one edit that turns a 409 into an approved publish,
 *   filed as no edit at all. `isSameText` answers with BOTH lenses, so a save
 *   that moves the gate's verdict always leaves a row, and one that changes the
 *   text only for the history (a reorder) does too.
 *
 * `previous === null` is a change by construction — a first override where the
 * channel had none is new text, and there is nothing to compare it against.
 */
function humanVersionBody(previous: string | null, next: string | null | undefined): string | null {
  if (next === undefined || next === null) return null;
  if (previous === null) return next;
  return isSameText(previous, next) ? null : next;
}

/** The `ai` version bodies of one item, by level, oldest first. */
type AiVersionBodies = {
  item: string[];
  adaptations: Record<string, string[]>;
};

/**
 * Groups version rows by level: `null` is the master body, everything else
 * keys by adaptation.
 *
 * EVERY adaptation of the item gets a key, `[]` when it has no `ai` rows of its
 * own, so the web never has to tell "this channel has no AI text" apart from
 * "the response forgot to mention it" — and a human-written item, which has no
 * version rows at all, comes back as empty lists rather than as an error or a
 * missing field.
 */
function groupAiVersionBodies(adaptationIds: string[], rows: AiVersionRow[]): AiVersionBodies {
  const item: string[] = [];
  const adaptations: Record<string, string[]> = Object.fromEntries(
    adaptationIds.map((id) => [id, [] as string[]]),
  );
  for (const row of rows) {
    if (row.adaptationId === null) {
      item.push(row.body);
      continue;
    }
    // A version row cascades with its adaptation, so it can only ever name one
    // of the ids above; the fallback keeps the body rather than dropping it
    // silently if that ever stops being true.
    const bodies = adaptations[row.adaptationId] ?? [];
    bodies.push(row.body);
    adaptations[row.adaptationId] = bodies;
  }
  return { item, adaptations };
}

@Injectable()
export class ContentRepository {
  constructor(private readonly queue: QueueService) {}

  private async adaptationsFor(orgId: string, contentItemId: string) {
    return db
      .select(ADAPTATION_COLUMNS)
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
        ),
      );
  }

  /**
   * The item-level `ai` version evidence for many items at once, keyed by item.
   *
   * `list` needs the badge's answer for every card, and the badge's answer is
   * the gate's question asked of these rows. One `IN` query rather than a read
   * per item: this is already an N+1 for adaptations, and the cure for that is
   * not a second one.
   *
   * `adaptation_id IS NULL` because the card's badge is about the MASTER body.
   * A channel override's provenance is a detail of the item screen, and joining
   * an adaptation's AI text into the item's reference would compare a body
   * against text the adapter rewrote for a platform — which never matches, so
   * every card would read "human-edited".
   *
   * Ordered `created_at, id`, the same order as the gate's read and `get`'s,
   * because the badge's deletion clause counts against the FIRST `scope =
   * 'full'` row. This query deliberately had no `ORDER BY` while the badge
   * asked whether the body matched ANY row — "any" has no first — and the
   * moment it stopped asking that, an unordered read became a silently wrong
   * one: no order means no first full row, and picking whatever the planner
   * returned first makes the deletion clause a no-op.
   */
  private async itemAiEvidence(orgId: string, itemIds: string[]): Promise<Map<string, AiEvidence>> {
    if (itemIds.length === 0) return new Map();
    const rows = await db
      .select({
        contentItemId: schema.contentVersions.contentItemId,
        body: schema.contentVersions.body,
        scope: schema.contentVersions.scope,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          inArray(schema.contentVersions.contentItemId, itemIds),
          isNull(schema.contentVersions.adaptationId),
          eq(schema.contentVersions.origin, "ai"),
        ),
      )
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));
    return collectAiEvidence(rows, (row) => row.contentItemId);
  }

  async list(orgId: string, status?: string) {
    if (status !== undefined && !(schema.CONTENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `Unknown status: ${status}. Expected one of: ${schema.CONTENT_STATUSES.join(", ")}`,
      );
    }
    const where = status
      ? and(
          eq(schema.contentItems.orgId, orgId),
          // Safe: membership just verified above, so the widened `string` really is one
          // of the literal statuses drizzle's column type expects.
          eq(schema.contentItems.status, status as ContentStatusValue),
        )
      : eq(schema.contentItems.orgId, orgId);
    const items = await db.select(ITEM_COLUMNS).from(schema.contentItems).where(where);
    const aiEvidence = await this.itemAiEvidence(
      orgId,
      items.map((item) => item.id),
    );
    return Promise.all(
      items.map(async (item) => {
        // The gate's question, on the card. See `get` for why the badge is a
        // boolean the server computes rather than a comparison the browser runs.
        const evidence = aiEvidence.get(item.id) ?? NO_AI_EVIDENCE;
        return {
          ...item,
          bodyIsAiVerbatim: allSentencesAi(item.body, evidence.bodies, evidence.firstFullBody),
          adaptations: await this.adaptationsFor(orgId, item.id),
        };
      }),
    );
  }

  /**
   * The `ai` version bodies of one item, both levels, oldest first.
   *
   * Same table, same org scoping and the same `created_at, id` order as the
   * publish gate's read in `requireHumanInvolvement`. The tiebreak is
   * load-bearing in both: the worker writes an item's versions and all its
   * adaptations' versions in ONE transaction, where `now()` — and therefore
   * `created_at` — is identical across them, so `created_at` alone is not a
   * total order and "oldest first" would be whatever the planner felt like.
   *
   * The same rows the gate reads, at a different grain rather than a different
   * reference. The lens dims a sentence that still matches ANY `ai` version;
   * the gate and the badge ask whether EVERY sentence does (`allSentencesAi`),
   * off this same list. `scope` comes back too, because that question's
   * deletion clause counts against the level's first `scope = 'full'` row —
   * read here and NOT forwarded to the browser, which dims a fragment like any
   * other text.
   *
   * The `org_id` predicate is defence in depth rather than this endpoint's only
   * tenant boundary: `get` has already 404'd an item belonging to another org
   * before this runs. It is what keeps a version row written with the wrong
   * `org_id` from being served as this org's own text, and the repository
   * convention that every read is scoped is worth more than the one saved
   * predicate.
   */
  private aiVersionRows(orgId: string, contentItemId: string) {
    return db
      .select(AI_VERSION_COLUMNS)
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, contentItemId),
          eq(schema.contentVersions.origin, "ai"),
        ),
      )
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(ITEM_COLUMNS)
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    const item = rows[0];
    if (!item) throw new NotFoundException("Content item not found");
    // Two independent reads of the same item, issued together: this method is
    // the response of every mutation on the resource as well as of the GET, so
    // it pays for its round trips more often than any other read here.
    const [adaptations, aiVersions] = await Promise.all([
      this.adaptationsFor(orgId, item.id),
      this.aiVersionRows(orgId, item.id),
    ]);
    /**
     * The provenance lens's reference text. Returned rather than a
     * server-computed mask because the browser would have to split the
     * current text identically to align a mask to it anyway (spec §4), and
     * two splitters that must agree are two splitters that will stop
     * agreeing.
     */
    const aiVersionBodies = groupAiVersionBodies(
      adaptations.map((adaptation) => adaptation.id),
      aiVersions,
    );
    /**
     * The badge's evidence, at the MASTER level — the same rows the lens is
     * handed, plus the `scope` the browser has no use for. Through
     * `collectAiEvidence` rather than a `find` here, so that "the first full
     * row" is decided in one place for the gate, the item and the queue alike.
     */
    const itemEvidence =
      collectAiEvidence(aiVersions, (row) => row.adaptationId).get(null) ?? NO_AI_EVIDENCE;
    return {
      ...item,
      adaptations,
      /**
       * The origin badge's answer — computed here rather than in the browser,
       * because the QUEUE has to be able to give it too and the queue has no
       * reference text to compute it from (see `itemAiEvidence`). Before this
       * field, a rewritten item's card read "AI-drafted" while its own detail
       * screen said "Human-edited" one click later, which is the exact claim
       * design §5 leans on to ship the lens off by default: the badge already
       * carries it at a glance on every card.
       *
       * The gate's own question (`allSentencesAi`, spec §2), off the same rows
       * the lens dims against, so the badge and the gate cannot give one screen
       * two answers. Whole-body equality could not: a refine's fragment never
       * EQUALS a whole body, so an accepted proposal made the badge caption the
       * model's own words "Human-edited" while the gate refused the same draft.
       * Fail-safe included: no version rows, or none with `scope = 'full'`,
       * means `true` — an item whose reference was never written keeps reading
       * AI-drafted instead of over-claiming an edit nobody made.
       */
      bodyIsAiVerbatim: allSentencesAi(item.body, itemEvidence.bodies, itemEvidence.firstFullBody),
      aiVersionBodies,
    };
  }

  async create(orgId: string, data: ContentCreate) {
    const channels = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, data.brandId),
          inArray(schema.channels.id, data.channelIds),
        ),
      );
    if (channels.length !== data.channelIds.length) {
      throw new NotFoundException("One or more channels do not belong to this brand");
    }

    const id = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.contentItems)
        .values({ orgId, brandId: data.brandId, title: data.title ?? null, body: data.body })
        .returning({ id: schema.contentItems.id });
      const itemId = inserted[0]?.id as string;
      await tx
        .insert(schema.adaptations)
        .values(
          channels.map((channel) => ({ orgId, contentItemId: itemId, channelId: channel.id })),
        );
      return itemId;
    });

    return this.get(orgId, id);
  }

  /**
   * 404s an item that does not exist in this org, 409s one whose text approval
   * has already pinned (see `EDITABLE_ITEM_STATUSES`), and holds the row lock
   * for the rest of the caller's transaction so the verdict cannot go stale
   * between the check and the write.
   *
   * Taking a `content_items` lock is only safe here because the edit paths
   * lock nothing else afterwards, and because `updateAdaptation` (which does
   * lock both) takes the `adaptations` lock first — the same order as
   * `approve`/`reject` and the worker (see `lockAdaptations`).
   *
   * Returns the body it locked, because `update` has to know whether this save
   * actually changed the text. Read here rather than in a second SELECT: the
   * lock is already held, so this is the one read that cannot be stale by the
   * time the write lands — and a version row written against a body some other
   * transaction had already replaced would record an edit that never happened.
   */
  private async requireEditableItem(tx: Tx, orgId: string, id: string): Promise<{ body: string }> {
    const rows = await tx
      .select({ status: schema.contentItems.status, body: schema.contentItems.body })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    const item = rows[0];
    if (!item) throw new NotFoundException("Content item not found");
    if (isEditableItemStatus(item.status)) return { body: item.body };
    throw new ConflictException(PINNED_ITEM_MESSAGE[item.status]);
  }

  /**
   * The author's own save, kept — a `full` row, `origin: 'human'`, stamped with
   * the user who typed it.
   *
   * Until this existed, exactly one thing wrote `content_versions`: the
   * worker's terminal write, always `origin: 'ai'`. No human action wrote a row
   * at all, so a version history had nothing to list and Restore nothing to
   * restore to.
   *
   * `scope: 'full'` because a save replaces the whole body; `fragment` belongs
   * to a refine's accepted proposal. `title` is left null, exactly as the
   * worker's own rows leave it: a row is written only when the BODY changed, so
   * a title carried along here would be a title history with every title-only
   * save missing from it.
   *
   * Called INSIDE the caller's transaction, after the body write and under the
   * locks the caller already holds, so a refused edit leaves no history of
   * itself.
   *
   * **An INSERT here is a lock on both FK targets, and the invariant is that
   * the caller already holds them.** An earlier draft of this comment claimed
   * the insert "adds no new lock to the documented order"; that is not what a
   * foreign key does. Postgres takes `FOR KEY SHARE` on every referenced row —
   * `content_items`, and the adaptation when `adaptationId` is set — and it is
   * a real lock, measured rather than reasoned about: in psql it waited 3.1 s
   * behind a concurrent `SELECT ... FOR UPDATE` on the parent, and two
   * transactions deadlock outright when one locks `content_items` first and
   * then inserts an adaptation-level row while the other holds the adaptation.
   *
   * The claim happens to be TRUE of both callers today, and only because of
   * what they lock: `update` writes `adaptationId: null` under the item's own
   * `FOR UPDATE`, and `updateAdaptation` takes the adaptation's `FOR UPDATE`
   * BEFORE the item's (`lockAdaptations`' order), so in both cases every row
   * this insert touches is already held in a strictly stronger mode and the
   * FK's own lock is a no-op.
   *
   * So the rule a future writer has to keep is not "this is free" but:
   *
   *   **An adaptation-level version row may only be written from a transaction
   *   that ALREADY holds that adaptation's `FOR UPDATE`.**
   *
   * 2b-2's "refine an override" is the obvious way to break it — a path that
   * locks the item, calls the model, and files a `fragment` row against an
   * adaptation it never locked takes `content_items` before `adaptations`,
   * which is precisely the inversion `lockAdaptations` documents as a genuine
   * deadlock against the worker's `markPublished`.
   *
   * Invisible to every read that asks about provenance: the gate, the origin
   * badge and the lens all filter `origin = 'ai'`, because a version the author
   * typed is not evidence that the model wrote a sentence.
   */
  private async recordHumanVersion(
    tx: Tx,
    row: {
      orgId: string;
      contentItemId: string;
      adaptationId: string | null;
      body: string;
      createdBy: string;
    },
  ): Promise<void> {
    await tx.insert(schema.contentVersions).values({ ...row, origin: "human", scope: "full" });
  }

  async update(orgId: string, id: string, data: ContentUpdate, userId: string) {
    await db.transaction(async (tx) => {
      const current = await this.requireEditableItem(tx, orgId, id);
      await tx
        .update(schema.contentItems)
        .set(data)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
      const versionBody = humanVersionBody(current.body, data.body);
      if (versionBody !== null) {
        await this.recordHumanVersion(tx, {
          orgId,
          contentItemId: id,
          adaptationId: null,
          body: versionBody,
          createdBy: userId,
        });
      }
    });
    return this.get(orgId, id);
  }

  /**
   * Same pin as `update`, one level down: an approved item's per-channel
   * override is the exact text that channel will receive, so it is frozen for
   * as long as a delivery is outstanding.
   *
   * Both conditions are checked, not just the item's: the two can disagree
   * after a partial fan-out, where one channel published and the item is still
   * `approved`.
   *
   * A changed override leaves a version row of its own, at the ADAPTATION's
   * level — the same rule as `update`, one level down, and the level matters:
   * filing one channel's text as the master body's would make a history that
   * restores the wrong text into the wrong place. Spec §6 says so explicitly
   * because the design's earlier draft was silent about this method.
   */
  async updateAdaptation(
    orgId: string,
    contentItemId: string,
    adaptationId: string,
    data: AdaptationUpdate,
    userId: string,
  ) {
    return db.transaction(async (tx) => {
      // `adaptations` before `content_items` — the lock order every other
      // writer of this pair uses (see `lockAdaptations`). `body` comes back for
      // the same reason `requireEditableItem` returns the item's: it is the
      // text this save is compared against, read under the lock that makes the
      // comparison hold until the write lands.
      const locked = await tx
        .select({ status: schema.adaptations.status, body: schema.adaptations.body })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .limit(1)
        .for("update");
      const current = locked[0];
      if (!current) throw new NotFoundException("Adaptation not found");

      await this.requireEditableItem(tx, orgId, contentItemId);
      if (!isEditableAdaptationStatus(current.status)) {
        throw new ConflictException(PINNED_ADAPTATION_MESSAGE[current.status]);
      }

      const rows = await tx
        .update(schema.adaptations)
        .set({ body: data.body })
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .returning(ADAPTATION_COLUMNS);
      const updated = rows[0];
      if (!updated) throw new NotFoundException("Adaptation not found");

      const versionBody = humanVersionBody(current.body, data.body);
      if (versionBody !== null) {
        await this.recordHumanVersion(tx, {
          orgId,
          contentItemId,
          adaptationId,
          body: versionBody,
          createdBy: userId,
        });
      }
      return updated;
    });
  }

  /**
   * 404s an item that does not exist in this org, WITHOUT taking a row lock on
   * it — the lock on `content_items` must not be acquired before the one on
   * `adaptations` (see `lockAdaptations`), and this check runs BEFORE them. A
   * concurrent delete between this check and the later status write is
   * harmless: the write matches no rows and the reread at the end of the call
   * 404s anyway.
   *
   * That is what separates this from `requireNotPublished`, which asks about
   * the same row a few lines later and DOES lock it: the difference is not the
   * question, it is which side of `lockAdaptations` the read falls on. Merging
   * the two into one locked read would put `content_items` first and invert the
   * order for real.
   */
  private async requireItem(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("Content item not found");
  }

  /**
   * Refuses to approve an item that has NO adaptations at all.
   *
   * Without this, `approve` returned 200 and stored `approved` while enqueueing
   * nothing whatsoever: a post that reads sent on every screen and was never
   * sent anywhere, with no failure, no `publications` row and no job to explain
   * it. The generation path already refuses exactly this shape and says why —
   * losing every channel mid-run is a terminal `every_channel_deleted` rather
   * than an item with zero adaptations, because "`approve` would happily mark
   * approved while enqueueing nothing at all" (generate.service.ts). The api
   * cannot produce the shape on creation (`contentCreateSchema` requires at
   * least one channel), but deleting a channel cascades its adaptations away,
   * so an item that had channels yesterday can have none today.
   *
   * A 409 rather than a 400: the request is well formed and it was valid until
   * the channels went away. The message says what happened rather than offering
   * a recovery, because there is none to offer — nothing adds an adaptation to
   * an existing item; the content has to be created again for the new channel.
   *
   * An unlocked read, and it does not need to be one: this asks whether the
   * item has any channels at all, and a channel deleted a moment after the
   * check leaves a queued job whose delivery fails on its own terms. It is the
   * "nothing at all" case that has no failure path to fall back on.
   */
  private async requireAdaptations(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, id)))
      .limit(1);
    if (rows.length === 0) {
      throw new ConflictException(
        "This content has no channels left to publish to; every channel it was written for has " +
          "been deleted",
      );
    }
  }

  /**
   * Refuses to re-decide an item that has already gone out.
   *
   * Existence was never the only precondition: `setItemStatus` writes
   * unconditionally, so approving or rejecting a fully published item returned
   * 200 and stored `approved`/`rejected` over `published` — a permanent lie
   * about a post that is live in someone's channel, with nothing to repair it
   * (`recomputeItemStatus` only ever runs from the worker, and the worker is
   * long done by then).
   *
   * Read AFTER the caller has locked the adaptations, and that is the whole
   * point of it being a separate step from `requireItem`: the worker's
   * `markPublished` locks the adaptations and only then promotes the item, so a
   * status read taken before the lock can still say `approved` about a publish
   * that commits a moment later.
   *
   * **`FOR UPDATE`, because the adaptation locks do not cover `approve`.** The
   * worker's `markPublished` always runs against a `publishing` adaptation.
   * `reject` targets that status and therefore waits on the worker's row lock
   * before it ever gets here; `approve` deliberately does NOT (see its own
   * comment), so its `lockAdaptations` touches nothing the worker holds and it
   * arrives at this line with no synchronisation at all. With an unlocked read
   * it then saw the COMMITTED `approved` while the worker's promotion sat
   * uncommitted a statement away, passed, and queued its own write behind the
   * worker's row lock — landing `approved` ON TOP of `published`. Measured, not
   * theorised: 200 returned, the item stored as `approved` beside a `published`
   * adaptation and a live post — and an item stored that way can then be
   * REJECTED, which is how a published item comes to read `rejected` next to a
   * post nobody can take back. Under the lock this transaction either waits for
   * the worker and reads `published` (409), or gets there first and the
   * worker's promotion lands afterwards on a status it has already decided.
   *
   * An earlier version of this comment justified the unlocked read by claiming
   * a `FOR UPDATE` here "would invert the lock order the whole codebase depends
   * on". **It would not, and that wrong reason is how the bug comes back.**
   * Both callers have ALREADY taken the adaptation locks by the time they reach
   * this line (`lockAdaptations`, the step this one is deliberately separate
   * from), so locking `content_items` after them is precisely the documented
   * order — `adaptations`, then `content_items` — that the worker's
   * `markPublished`/`markFailed` also follow. The lock this call takes is then
   * held for the rest of the transaction, which is what also makes the gate
   * below it (`requireHumanInvolvement`) read a body nobody can replace before
   * the status write lands.
   */
  private async requireNotPublished(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    if (rows[0]?.status === "published") {
      throw new ConflictException(
        "This content has already been published; it can no longer be approved or rejected",
      );
    }
  }

  /**
   * The publish rule: approval is refused when NO HUMAN HAS OPENED THE ITEM AND
   * NOTHING HAS BEEN TOUCHED.
   *
   * Three clauses, all of which must hold for the refusal — any one of them
   * being false is a human in the loop, and approval proceeds:
   *
   * 1. THE MODEL WROTE SOMETHING HERE: the item's `origin` is `ai`, OR an `ai`
   *    version row exists at ANY level of it — the item's own body or any
   *    adaptation's. A wholly human item is nobody's business here, and this
   *    clause is what keeps it out: it has no `ai` rows at all, so every "is
   *    this still the AI's text?" question below would answer "cannot prove
   *    otherwise" and lock the product's ordinary flow.
   *    The adaptation half is spec §5, closing the limit this comment used to
   *    record: entering on the ITEM's origin alone let a human-written item
   *    carrying AI-WRITTEN ADAPTATIONS skip every check below and ship its
   *    channel text unread. Nothing produced that shape when the gate was
   *    written (the terminal write marks the item `ai` too); increment 2b-2's
   *    refine verbs on a hand-typed draft produce it immediately.
   *    The origin half is NOT redundant with the row half, and dropping it
   *    would be a hole rather than a simplification: an `ai` item whose version
   *    rows a worker bug never wrote has no rows to find, and "no evidence"
   *    must refuse, not walk out of the gate (see "missing evidence" below).
   *    `adaptations.origin` is deliberately NOT a third disjunct — it defaults
   *    to `human`, so it can only fail to enter, but the version row is the
   *    evidence this rule is actually made of and the column is not.
   *    The cost, paid knowingly: a draft whose body a human typed themselves is
   *    refused until they open it, and for that shape ONLY opening it helps —
   *    see `UNREAD_AI_DRAFT_OPEN_ONLY_MESSAGE`, which says so.
   * 2. `first_opened_at IS NULL` — nobody has opened it (`markOpened`).
   * 3. EVERY SENTENCE of the text is still the model's, AT BOTH LEVELS. The
   *    item body against the item's own `ai` rows, and EVERY adaptation against
   *    its own — because `adaptations.body ?? contentItems.body` is what the
   *    worker actually sends (publish.service.ts), so a rule that checked only
   *    the master text would pass an item whose every channel still ships
   *    untouched AI.
   *
   * Clause 3 used to be a whole-body equality against the FIRST `ai` row per
   * level, and increment 2b's refine verbs break that: an accepted proposal
   * merges a fragment into the body, the body then equals no stored row, and
   * equality reads a human touch that never happened — the gate publishing a
   * draft nobody opened, to exactly the callers it was written for. The
   * question is therefore asked one sentence at a time (`allSentencesAi`, spec
   * §2), which needs TWO things per level rather than one row:
   *
   * - EVERY `ai` body, for the mask. A sentence still counts as the model's
   *   when ANY `ai` row wrote it, so an accepted proposal's fragment covers the
   *   sentence it replaced. The rows are NOT concatenated — see
   *   `aiSentenceMaskAny`, which keeps each version's own multiset count.
   * - The first `scope = 'full'` row, as the deletion clause's anchor. A mask
   *   has no notion of count, so a body that is a strict subset of the model's
   *   sentences would read "all AI" and a caller who TRIMMED the draft would be
   *   refused with a message telling them to edit it. A fragment cannot be that
   *   anchor: it is shorter than the body it edits by construction, so counting
   *   its sentences as the body's would read every refine as a deletion.
   *
   * That is literally the same call the badge makes (`get`, `list`) and the
   * fine grain of what the lens paints, off the same rows — one question, two
   * references, instead of three formulas that could disagree on one screen.
   * Never string equality either way:
   * the comparison normalises whitespace and Unicode composition, so a stray
   * space or an NFD paste is not a human touch.
   *
   * Missing evidence refuses, and PARTIAL evidence refuses with it. An `ai`
   * item with no version row to compare against reads as untouched, an
   * adaptation with no version row of its own does too, and so does a level
   * whose only `ai` rows are fragments — with no `full` row a deletion and a
   * rewrite are indistinguishable. The promise is about what we can PROVE a
   * human touched, and the recovery is one click (open it) rather than a
   * published draft nobody read. That direction matters because
   * `adaptations.origin` defaults to `human` — deriving "touched" from the
   * origin column instead would turn a worker that forgot to set it into an
   * open publish gate.
   *
   * **`FOR UPDATE`, because the verdict is about the text that will actually
   * go out.** This used to be a plain read, excused with the same wrong reason
   * `requireNotPublished` records: locking `content_items` here does not invert
   * any order, since `lockAdaptations` has already run and this is the second
   * half of the pair. What the unlocked read did allow was an edit landing
   * UNDERNEATH an approval — the editor's transaction holds the item's lock
   * (`requireEditableItem`), this gate reads the committed OLD body and passes
   * it, the loop enqueues, and only then does `setItemStatus` queue behind that
   * lock: the editor commits its replacement, approve commits `approved` on top
   * of it, and the channel receives text the gate never saw. Measured with a
   * revert to the model's verbatim draft: 200, the item queued for delivery
   * carrying an unopened, untouched AI body — the exact shape this method
   * exists to refuse.
   *
   * The lock is already held by `requireNotPublished` a line earlier, so this is
   * a re-lock of a row this transaction owns and costs nothing — and, said
   * plainly because a mutation test was run rather than reasoned about:
   * deleting THIS `.for("update")` alone fails no test, while deleting both
   * fails "409s an approve whose gate would otherwise judge a body the editor
   * is replacing". It is kept because the redundancy is the point: this method
   * decides what text ships, and it should not depend on a caller continuing to
   * lock the row for it two refactors from now.
   */
  private async requireHumanInvolvement(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({
        body: schema.contentItems.body,
        origin: schema.contentItems.origin,
        firstOpenedAt: schema.contentItems.firstOpenedAt,
      })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    const item = rows[0];
    // `requireItem` already 404'd a missing row; a delete racing this read is
    // harmless (the writes below it match nothing).
    if (!item) return;

    // The `ai` version rows are the provenance evidence. Filtered on origin
    // because increment 2 appends human versions to the same table — a version
    // the author typed is not evidence that the model wrote a sentence — and
    // ordered so "first" cannot drift: the worker writes item and adaptation
    // versions in one transaction, where `now()` — and therefore `created_at` —
    // is identical for all of them, so `created_at` alone is not a total order.
    const versions = await tx
      .select({
        adaptationId: schema.contentVersions.adaptationId,
        body: schema.contentVersions.body,
        scope: schema.contentVersions.scope,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, id),
          eq(schema.contentVersions.origin, "ai"),
        ),
      )
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));

    // Clause 1, and the reason this query moved ABOVE the bail-out: the rows
    // that answer "did the model write any of this" are the same rows the
    // checks are made of, so the gate asks for them once. `contentItemId` is
    // set on an adaptation's version rows too, so this one list is "the item or
    // any of its adaptations" — no second query, and no chance of the entry and
    // the evidence disagreeing about which rows exist.
    if (item.origin !== "ai" && versions.length === 0) return;

    /**
     * Every `ai` body per level for the mask, and each level's first `full` row
     * for the deletion clause — the same collector the badge reads through, so
     * the gate and the badge cannot come to disagree about which row is first.
     */
    const aiEvidence = collectAiEvidence(versions, (version) => version.adaptationId);

    const adaptations = await tx
      .select({ id: schema.adaptations.id, body: schema.adaptations.body })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, id)));

    /**
     * Is every sentence of `current` still the model's, judged against one
     * LEVEL's evidence — `null` for the master body, an adaptation id for a
     * channel's own text.
     *
     * Takes the level rather than the reference strings so the cleared-override
     * branch below can switch both of them together and cannot switch one
     * without the other. Untouched unless we can prove otherwise:
     * `allSentencesAi` answers true for a level with no rows and for one with
     * no `full` row — see "missing evidence" above.
     */
    const stillAi = (current: string, level: string | null): boolean => {
      const evidence = aiEvidence.get(level) ?? NO_AI_EVIDENCE;
      return allSentencesAi(current, evidence.bodies, evidence.firstFullBody);
    };

    const nobodyOpened = item.firstOpenedAt === null;
    const bodyIsAi = stillAi(item.body, null);
    const everyChannelIsAi = adaptations.every((adaptation) =>
      // The channel's text AND the version it is judged against, together.
      // `adaptations.body ?? content_items.body` is the worker's own fallback,
      // so a cleared override means this channel ships the ITEM's text — and it
      // must then be compared with the ITEM's AI version. Giving the shipped
      // text the fallback but not the reference compared the master body
      // against the ADAPTATION's AI version, which the adapter rewrote for the
      // platform and so never matches: clearing an override read as a human
      // edit and published every channel's verbatim AI text. The shipped web UI
      // sends exactly that null (content/[id]/page.tsx, an emptied textarea).
      adaptation.body === null ? stillAi(item.body, null) : stillAi(adaptation.body, adaptation.id),
    );

    if (nobodyOpened && bodyIsAi && everyChannelIsAi) {
      // Which refusal is the true one is decided by ONE fact: whether the body
      // has a complete `ai` version to be judged against. With one, an edit is
      // a real recovery — a sentence of the author's own, or a deletion, and
      // `bodyIsAi` turns false. Without one, `allSentencesAi` short-circuits on
      // missing evidence and no body a caller could type would ever answer
      // differently, so telling them to edit it is telling them to do something
      // that cannot work. Read off the collected evidence rather than off
      // `item.origin`, because the shapes that cannot be edited out are not
      // only the hand-typed one: an `ai` item whose version rows are missing
      // altogether, or whose only `ai` row is a refine `fragment`, are the same
      // dead end and get the same sentence.
      const bodyEvidence = aiEvidence.get(null) ?? NO_AI_EVIDENCE;
      throw new ConflictException(
        bodyEvidence.firstFullBody === undefined
          ? UNREAD_AI_DRAFT_OPEN_ONLY_MESSAGE
          : UNREAD_AI_DRAFT_MESSAGE,
      );
    }
  }

  /**
   * Records that a human has opened this item, once.
   *
   * Its own endpoint rather than a side effect of the GET, and that is the
   * whole design: the public API and the MCP server will issue GETs with no
   * human anywhere near them, and a GET that stamped the read receipt would
   * hand them the ability to open the publish gate by listing content. The web
   * app fires this from the item page after render.
   *
   * `WHERE first_opened_at IS NULL` keeps the FIRST open: the column answers
   * "has anyone ever read this", so overwriting it on every visit would lose
   * the only timestamp anyone would want, and makes concurrent opens a no-op
   * for the loser rather than a lost update.
   *
   * Idempotent: a second call is 204 too. Zero rows updated is ambiguous —
   * already stamped, or not this org's item — so it is disambiguated with one
   * read, because an org must not be able to stamp another org's draft (or
   * learn that it exists).
   */
  async markOpened(orgId: string, id: string): Promise<void> {
    const stamped = await db
      .update(schema.contentItems)
      // A JS Date, matching `scheduledAt`: the column is `timestamp` without a
      // zone and drizzle writes/reads it as UTC on both sides, so this
      // round-trips whatever the database's own timezone is. Nothing compares
      // it to anything — the rule above only asks whether it is null.
      .set({ firstOpenedAt: new Date() })
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.id, id),
          isNull(schema.contentItems.firstOpenedAt),
        ),
      )
      .returning({ id: schema.contentItems.id });
    if (stamped.length > 0) return;

    const existing = await db
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (existing.length === 0) throw new NotFoundException("Content item not found");
  }

  private async setItemStatus(
    tx: Tx,
    orgId: string,
    id: string,
    status: ContentStatusValue,
  ): Promise<void> {
    await tx
      .update(schema.contentItems)
      .set({ status })
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
  }

  /**
   * Locks the adaptations of one item that are in `statuses`, inside the
   * caller's transaction.
   *
   * `FOR UPDATE` is load-bearing, not decoration: the worker claims an
   * adaptation with an UPDATE (`markPublishing`), which takes the same row
   * lock. Locking here serialises "is this still deliverable?" against "I am
   * delivering it now" instead of letting both read a stale row — either we
   * see the worker's write, or the worker's claim waits for this transaction
   * and then finds a status it must not publish from (see the worker's
   * `markPublishing`).
   *
   * Callers must take this lock BEFORE LOCKING OR writing `content_items`. The
   * worker's `markPublished`/`markFailed` lock adaptations first and only then
   * the parent item (`recomputeItemStatus`), so taking the item first here
   * would give the two sides opposite lock orders — a genuine deadlock whenever
   * a publish finishes at the same moment as an approve or reject.
   *
   * "Before", not "instead of": everything the caller does to `content_items`
   * AFTER this — `requireNotPublished`'s `FOR UPDATE`, the gate's read, the
   * status write — is in the documented order and belongs under a lock. It was
   * the reading of `content_items` WITHOUT one, excused as protecting this
   * order, that let an approve overwrite a `published` item and let an edit
   * land underneath an approval.
   *
   * "Writing `content_items`" includes writing anything that REFERENCES an
   * adaptation: a `content_versions` insert takes `FOR KEY SHARE` on both FK
   * targets, so filing an adaptation-level version row from a transaction
   * holding only the item's lock inverts this order exactly as an UPDATE
   * would. See `recordHumanVersion`, which states that invariant in full.
   *
   * `ORDER BY id` for the same reason one level down. Without it Postgres is
   * free to return an item's adaptations in any order, so two concurrent
   * approves of the same multi-channel item can lock its rows in opposite
   * orders and deadlock each other — a 500 on a request that is merely
   * duplicated, not wrong. A deterministic order makes the second approve wait
   * instead.
   */
  private lockAdaptations(
    tx: Tx,
    orgId: string,
    contentItemId: string,
    statuses: (typeof schema.ADAPTATION_STATUSES)[number][],
  ) {
    return tx
      .select({
        id: schema.adaptations.id,
        channelId: schema.adaptations.channelId,
        status: schema.adaptations.status,
        attemptCount: schema.adaptations.attemptCount,
      })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
          inArray(schema.adaptations.status, statuses),
        ),
      )
      .orderBy(schema.adaptations.id)
      .for("update");
  }

  /**
   * Approves an item and enqueues (or re-enqueues) its outstanding adaptations.
   *
   * `scheduled` is in the target set, not just `pending`/`failed`: without it
   * "Publish now" on an already-scheduled item returned 200, flipped the item
   * to `approved` and enqueued nothing, while the post still fired at the OLD
   * time — the UI reported a change that never happened. A scheduled
   * adaptation is genuinely rescheduled here: its outstanding job is cancelled
   * and a fresh one is enqueued with the new `startAfter`.
   *
   * `queued` and `publishing` are deliberately NOT targets. A queued
   * adaptation is already on its way out with no delay to change, and a
   * `publishing` one is mid-attempt: re-enqueueing either would cancel a live
   * job — for `publishing`, an entire transient-retry chain that may still
   * succeed on its own — for no user-visible gain. An in-flight attempt
   * records its own truth when it lands (`markPublished` writes
   * unconditionally; `markFailed` is now fenced on the status and attempt
   * count it was dispatched for, so a dead attempt can no longer overwrite a
   * row this path has since re-approved), and a `failed` outcome is
   * re-approvable.
   * (Rejecting DOES act on both — there the point is to stop the delivery, not
   * to move it.)
   *
   * An item that has ALREADY published every one of its adaptations is refused
   * with a 409 (`requireNotPublished`): there is nothing left to enqueue, and
   * the only lasting effect used to be overwriting `published` with `approved`.
   *
   * An item with NO adaptations left at all is refused too
   * (`requireAdaptations`) — same reason from the other end: approving it
   * enqueued nothing and reported success for a post that was never sent.
   *
   * And an AI draft that no human has opened or touched is refused too
   * (`requireHumanInvolvement`) — the promise, enforced here rather than in the
   * UI, because this is the only door to `enqueuePublish`.
   */
  async approve(orgId: string, id: string, scheduledAt: Date | null) {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const targets = await this.lockAdaptations(tx, orgId, id, ["pending", "failed", "scheduled"]);
      await this.requireNotPublished(tx, orgId, id);
      // After `requireNotPublished` too: an item whose channels are gone AND
      // which already published from them is a published item first.
      await this.requireAdaptations(tx, orgId, id);
      // After `requireNotPublished`: an item already live in a channel gets the
      // message about the post that went out, not one about reading it. Before
      // the loop, so a refusal costs no queue work.
      await this.requireHumanInvolvement(tx, orgId, id);

      for (const adaptation of targets) {
        // CURRENT attempt count (before this attempt) — see publishJobId's contract.
        let attemptCount = adaptation.attemptCount;
        if (adaptation.status === "scheduled") {
          // The cancelled job keeps its id, so the count must advance or the
          // re-enqueue would be swallowed by send()'s ON CONFLICT DO NOTHING.
          await this.queue.cancelPublish(tx, adaptation.id, orgId);
          attemptCount += 1;
        }
        await tx
          .update(schema.adaptations)
          .set({
            status: scheduledAt ? "scheduled" : "queued",
            scheduledAt,
            lastError: null,
            attemptCount,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
        await this.queue.enqueuePublish(
          tx,
          { id: adaptation.id, orgId, channelId: adaptation.channelId, attemptCount },
          scheduledAt,
        );
      }

      await this.setItemStatus(tx, orgId, id, "approved");
    });

    return this.get(orgId, id);
  }

  /**
   * Rejects an item AND stops anything it already had in flight.
   *
   * Flipping `content_items.status` alone was not a rejection at all: the
   * adaptations stayed `queued`/`scheduled`, their pg-boss jobs stayed live,
   * and the worker never looked at the parent item — so approving with a
   * schedule and then rejecting still published the post the next day. Every
   * outstanding adaptation goes back to `pending` and its job is cancelled, in
   * one transaction with the status write, so the queue can never disagree
   * with the database.
   *
   * `publishing` counts as outstanding, and leaving it out stranded the row
   * for good. A transient platform failure leaves the adaptation `publishing`
   * for the whole retry chain (`recordTransient` deliberately does not move
   * the status). A reject during that window used to match nothing: no job
   * cancelled, no status reset — and then the next retry loaded the item, saw
   * `rejected` and returned normally, which completes the job and ends the
   * chain. That also removed the dead-letter delivery that would otherwise
   * have terminated the row, so the adaptation sat in `publishing` forever
   * with no job behind it, and re-approve (which skips `publishing`) silently
   * did nothing.
   *
   * `attempt_count` advances for each cancelled job: a cancelled pg-boss row
   * keeps its id, so without the bump a later re-approve would derive the same
   * id, `send()` would suppress it as a duplicate, and the re-approve would
   * 409 forever (see `publishJobId`).
   *
   * A PUBLISHED item is the one case where none of that is available, and it
   * is refused with a 409 (`requireNotPublished`) rather than accepted. The
   * promise above — "rejects an item AND stops anything it already had in
   * flight" — is not something this method can keep once the post is live in
   * someone's channel; all a 200 bought was a row that said `rejected` about a
   * published post. Saying so out loud is the honest answer, and it is the one
   * the UI can render.
   */
  async reject(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const outstanding = await this.lockAdaptations(tx, orgId, id, [
        "queued",
        "scheduled",
        "publishing",
      ]);
      await this.requireNotPublished(tx, orgId, id);

      for (const adaptation of outstanding) {
        await this.queue.cancelPublish(tx, adaptation.id, orgId);
        await tx
          .update(schema.adaptations)
          .set({
            status: "pending",
            scheduledAt: null,
            attemptCount: adaptation.attemptCount + 1,
            // Cleared for the same reason `approve` clears it: the row is back
            // to "nothing has been attempted", and leaving the last platform
            // error behind makes a rejected adaptation look like a failed one.
            lastError: null,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }

      await this.setItemStatus(tx, orgId, id, "rejected");
    });

    return this.get(orgId, id);
  }
}
