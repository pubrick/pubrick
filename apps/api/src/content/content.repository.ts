import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type AdaptationUpdate,
  type ContentCreate,
  type ContentUpdate,
  isUntouchedAi,
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
   * human-edited depending on whether the body still matches the AI's own
   * first version.
   */
  origin: schema.contentItems.origin,
  createdAt: schema.contentItems.createdAt,
  updatedAt: schema.contentItems.updatedAt,
};

/** Validated (not `as never`-cast) against this at the API boundary in `list()`. */
type ContentStatusValue = (typeof schema.CONTENT_STATUSES)[number];

type AdaptationStatusValue = (typeof schema.ADAPTATION_STATUSES)[number];

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
 * Written for the operator, not the log: it names the two things that clear the
 * refusal, because both are one act away and neither is discoverable from
 * "409 Conflict". The web app effectively never sees this — its item page fires
 * `POST /:id/opened` on render — which is exactly why it must read well for the
 * callers that will: the public API, the MCP server, and a script.
 */
const UNREAD_AI_DRAFT_MESSAGE =
  "No one has read this AI-written draft yet; open it, or edit it, before approving";

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
   */
  externalUrl: sql<string | null>`(
    select external_url from publications
    where adaptation_id = adaptations.id and status = 'published'
    order by created_at desc
    limit 1
  )`,
};

/**
 * The columns `get` needs to answer "which sentences are still the AI's" —
 * which level a version belongs to, and its text. Nothing wider: the caller
 * dims sentences, and a version's title, run, author and timestamp would be
 * payload nobody reads and an allowlist nobody could shrink again.
 */
const AI_VERSION_COLUMNS = {
  adaptationId: schema.contentVersions.adaptationId,
  body: schema.contentVersions.body,
};

type AiVersionRow = { adaptationId: string | null; body: string };

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
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        adaptations: await this.adaptationsFor(orgId, item.id),
      })),
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
   * The SEMANTICS deliberately differ from the gate's, and spec §3 is the table
   * that says why. The gate reads only the FIRST `ai` row per level, because it
   * answers "has any human been involved at all". The lens dims a sentence that
   * still matches ANY `ai` version, so it needs every row. Today they coincide —
   * there is exactly one `ai` row per level — and increment 2b's refine verbs
   * write the second, at which point reusing the gate's reference here would
   * render refined AI text as the human's own with nothing to notice it.
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
    return {
      ...item,
      adaptations,
      /**
       * The provenance lens's reference text. Returned rather than a
       * server-computed mask because the browser would have to split the
       * current text identically to align a mask to it anyway (spec §4), and
       * two splitters that must agree are two splitters that will stop
       * agreeing.
       */
      aiVersionBodies: groupAiVersionBodies(
        adaptations.map((adaptation) => adaptation.id),
        aiVersions,
      ),
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
   */
  private async requireEditableItem(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    const item = rows[0];
    if (!item) throw new NotFoundException("Content item not found");
    if (isEditableItemStatus(item.status)) return;
    throw new ConflictException(PINNED_ITEM_MESSAGE[item.status]);
  }

  async update(orgId: string, id: string, data: ContentUpdate) {
    await db.transaction(async (tx) => {
      await this.requireEditableItem(tx, orgId, id);
      await tx
        .update(schema.contentItems)
        .set(data)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
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
   */
  async updateAdaptation(
    orgId: string,
    contentItemId: string,
    adaptationId: string,
    data: AdaptationUpdate,
  ) {
    return db.transaction(async (tx) => {
      // `adaptations` before `content_items` — the lock order every other
      // writer of this pair uses (see `lockAdaptations`).
      const locked = await tx
        .select({ status: schema.adaptations.status })
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
      return updated;
    });
  }

  /**
   * 404s an item that does not exist in this org, WITHOUT taking a row lock on
   * it — the lock on `content_items` must not be acquired before the one on
   * `adaptations` (see `lockAdaptations`). A concurrent delete between this
   * check and the later status write is harmless: the write matches no rows and
   * the reread at the end of the call 404s anyway.
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
   * that commits a moment later. Reading it under the lock means we either see
   * the promotion or the worker has not made it yet. A plain read, not a
   * `FOR UPDATE` — locking `content_items` here would invert the lock order the
   * whole codebase depends on (see `lockAdaptations`).
   */
  private async requireNotPublished(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
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
   * 1. `origin === "ai"`. A human-written item is nobody's business here, and
   *    this clause is what keeps it out: a human draft has no version rows at
   *    all, so every "is this still the AI's text?" question below would answer
   *    "cannot prove otherwise" and lock the product's ordinary flow.
   *    KNOWN LIMIT, deliberately left as the spec writes it: the gate is the
   *    ITEM's origin, so a human-written item carrying AI-WRITTEN ADAPTATIONS —
   *    the "AI-adapted" badge spec §6 anticipates — never reaches the checks
   *    below, and its channel text could ship unread. Nothing produces that
   *    shape today (the terminal write always marks the item `ai` too), and
   *    increment 2's refine verbs are what would. Widening the gate to "any
   *    first `ai` version row exists for this item or its adaptations" closes
   *    it, at the cost of refusing a draft whose body a human typed themselves
   *    until they open it.
   * 2. `first_opened_at IS NULL` — nobody has opened it (`markOpened`).
   * 3. The text is still verbatim what the AI wrote, AT BOTH LEVELS. The item
   *    body against the item's own first `ai` version, and EVERY adaptation
   *    against its own — because `adaptations.body ?? contentItems.body` is
   *    what the worker actually sends (publish.service.ts), so a rule that
   *    checked only the master text would pass an item whose every channel
   *    still ships untouched AI.
   *
   * Comparison is `isUntouchedAi`, never string equality: it normalises
   * whitespace and Unicode composition, so a stray space or an NFD paste is not
   * a human touch — and the same function draws the per-sentence mask in the
   * UI, so the badge and this gate cannot disagree.
   *
   * Missing evidence refuses. An `ai` item with no version row to compare
   * against reads as untouched, and an adaptation with no version row of its
   * own does too: the promise is about what we can PROVE a human touched, and
   * the recovery is one click (open it) rather than a published draft nobody
   * read. That direction matters because `adaptations.origin` defaults to
   * `human` — deriving "touched" from the origin column instead would turn a
   * worker that forgot to set it into an open publish gate.
   *
   * A plain read, no `FOR UPDATE`: locking `content_items` here would invert
   * the lock order the whole codebase depends on (see `lockAdaptations`).
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
      .limit(1);
    const item = rows[0];
    // `requireItem` already 404'd a missing row; a delete racing this read is
    // harmless (the writes below it match nothing).
    if (!item) return;
    if (item.origin !== "ai") return;

    // The FIRST `ai` version per level is the provenance reference. Filtered on
    // origin because increment 2 appends human versions to the same table, and
    // ordered so "first" cannot drift: the worker writes item and adaptation
    // versions in one transaction, where `now()` — and therefore `created_at` —
    // is identical for all of them.
    const versions = await tx
      .select({
        adaptationId: schema.contentVersions.adaptationId,
        body: schema.contentVersions.body,
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
    const firstAiVersion = new Map<string | null, string>();
    for (const version of versions) {
      if (!firstAiVersion.has(version.adaptationId)) {
        firstAiVersion.set(version.adaptationId, version.body);
      }
    }

    const adaptations = await tx
      .select({ id: schema.adaptations.id, body: schema.adaptations.body })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, id)));

    /** Untouched unless we can prove otherwise — see "missing evidence" above. */
    const stillAi = (current: string, aiVersion: string | undefined): boolean =>
      aiVersion === undefined || isUntouchedAi(current, aiVersion);

    const nobodyOpened = item.firstOpenedAt === null;
    const bodyIsAi = stillAi(item.body, firstAiVersion.get(null));
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
      adaptation.body === null
        ? stillAi(item.body, firstAiVersion.get(null))
        : stillAi(adaptation.body, firstAiVersion.get(adaptation.id)),
    );

    if (nobodyOpened && bodyIsAi && everyChannelIsAi) {
      throw new ConflictException(UNREAD_AI_DRAFT_MESSAGE);
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
   * Callers must take this lock BEFORE writing `content_items`. The worker's
   * `markPublished`/`markFailed` lock adaptations first and only then the
   * parent item (`recomputeItemStatus`), so writing the item first here would
   * give the two sides opposite lock orders — a genuine deadlock whenever a
   * publish finishes at the same moment as an approve or reject.
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
   * records its own truth when it lands (`markPublished`/`markFailed` both
   * write unconditionally), and a `failed` outcome is re-approvable.
   * (Rejecting DOES act on both — there the point is to stop the delivery, not
   * to move it.)
   *
   * An item that has ALREADY published every one of its adaptations is refused
   * with a 409 (`requireNotPublished`): there is nothing left to enqueue, and
   * the only lasting effect used to be overwriting `published` with `approved`.
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
