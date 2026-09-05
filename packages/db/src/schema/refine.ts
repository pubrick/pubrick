import { REFINE_VERBS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { contentItems } from "./content-items.js";
import { enumCheck } from "./enum-check.js";

/**
 * ONE STAGED REFINE PROPOSAL PER DRAFT — the text a model wrote for a
 * selection, held by the server between the press that paid for it and the
 * Accept that applies it.
 *
 * WHY A ROW AT ALL, when the browser already has the text on its screen. The
 * argument is trust, not convenience. Accepting a proposal writes a
 * `content_versions` row saying `origin = 'ai'` about it, and that row is the
 * product's EVIDENCE that a model wrote those sentences: the provenance lens
 * dims them, the origin badge captions the draft "AI-drafted", and the publish
 * gate counts them as text nobody has had to read. If Accept took the proposal
 * text from its caller, any caller could author that evidence about words a
 * person typed — the exact inversion increment 2b-1 exists to prevent,
 * arriving from the other side. Evidence a caller can author is not evidence.
 * So the text crosses the wire once, outward, and Accept reads the row.
 *
 * THE ROW IS IMMUTABLE. It is inserted complete, in one statement, and it is
 * only ever deleted whole — nothing in the product updates a column of it.
 * That is what lets Accept treat what it reads as unaltered: the row it locks
 * and reads is byte for byte the row this endpoint wrote out of the model's
 * reply, and a later press does not edit it into something else, it replaces
 * it. (An earlier design staged the row BEFORE the model call with a null
 * `proposal` and filled it in afterwards. It buys nothing — no reader displays
 * an in-flight proposal, and Accept would have to treat a null one as absent
 * anyway — and it costs both this immutability and the guarantee that a row's
 * existence means a proposal exists.)
 *
 * WHAT ACCEPT NEEDS OF IT, and why each column is here:
 *
 *  - `proposal` and `verb` — what the model returned, and which of the three
 *    fixed verbs it was answering. `reason` is the one-line justification the
 *    dossier's anti-pattern 6 requires beside any suggestion.
 *  - `selected_text` and `start_offset` — the ANCHOR. Accept locks the item,
 *    re-locates this exact text in the body it has locked, taking the
 *    occurrence nearest the stored offset, and derives its splice range from
 *    what it found. It does not trust the offsets on their own: the body may
 *    have moved under a person still reading the proposal, and an edit three
 *    paragraphs away must not throw away a call they paid for. It does not
 *    hash the body either, for the same reason.
 *  - `end_offset` — the range's other end, kept because "where it was" is the
 *    pair, and because the screen renders the proposal against the same span.
 *
 * There is deliberately NO lease and NO expiry. A lease bounds work whose end
 * nobody observes; a refine is one synchronous request with a wall-clock
 * budget, its end is observed by the process that started it, and its cost is
 * already written down in `usage_ledger`. What a lease would have bought is
 * split between two things that exist for better reasons: MONEY is bounded by
 * a rolling count of those ledger rows, and "one proposal at a time" is the
 * unique index below, where the next propose supersedes its predecessor — so a
 * row orphaned by a crashed request blocks nothing and needs no sweeper.
 *
 * NOT `usage_ledger`'s job and not a substitute for it: this row is what the
 * money BOUGHT, and the ledger row is the money. A proposal abandoned without
 * being accepted still cost what it cost, which is why the ledger carries
 * `content_item_id` and why deleting this row cannot erase the spend.
 */
export const refineProposals = pgTable(
  "refine_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The draft this proposal was written against. `cascade`: a proposal about
     * a deleted post is about nothing, and unlike the ledger there is no money
     * in it to preserve.
     */
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    /**
     * Who asked for it. `set null` on a deleted account, matching every other
     * authored row.
     *
     * This is the honest home for the person, and it is why the
     * `content_versions` row Accept writes carries `created_by = NULL`: the
     * MODEL wrote that fragment, and a human id on it would say a person typed
     * text they only approved. Which person asked belongs here, on the request.
     */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** One of `REFINE_VERBS`, pinned by the CHECK below as well as by the type. */
    verb: text("verb", { enum: REFINE_VERBS }).notNull(),
    /**
     * The anchor: the exact characters that were selected, as the SERVER
     * sliced them out of its own stored body. Never a string a caller sent —
     * see this table's own docstring.
     */
    selectedText: text("selected_text").notNull(),
    /**
     * Where that text sat, as a half-open range in UTF-16 code units — the
     * unit every JavaScript string offset is measured in, and the unit
     * `DimmedTextarea` reports its selection in.
     *
     * NOT re-derivable from `selected_text` in SQL, and no constraint here
     * tries: Postgres `length()` counts code POINTS, so
     * `end_offset - start_offset = length(selected_text)` is false for every
     * selection containing an emoji or any other astral character — which is
     * ordinary social copy, not a corner. The pair is checked below only for
     * the things that are true in both units: non-negative, and non-empty.
     */
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    /** The model's replacement for `selected_text`. */
    proposal: text("proposal").notNull(),
    /** One short sentence saying what changed, in the BRAND's content language. */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("refine_proposals_org_id_idx").on(t.orgId),
    /**
     * AT MOST ONE STAGED PROPOSAL PER DRAFT, as a constraint rather than a
     * hope. The screen shows one proposal card, and a second row for the same
     * item would be a proposal nobody can see and nobody will ever discard.
     * The next propose deletes what is here and inserts in the same
     * transaction, so pressing Refine again supersedes rather than
     * accumulates — and that is also what makes an expiry unnecessary.
     *
     * On `content_item_id` alone, not `(org_id, content_item_id)`: an item
     * belongs to exactly one org, so the wider key would admit a second row
     * for the same draft under a different org id — precisely the row the
     * supersede must be able to find and delete.
     */
    uniqueIndex("refine_proposals_content_item_id_idx").on(t.contentItemId),
    /**
     * Pinned in the database as well as in the types — see `enumCheck`. The
     * verb decides which fixed role lines a call was made with, and a row
     * outside the set is a proposal no reader can explain.
     */
    enumCheck("refine_proposals_verb_check", t.verb, REFINE_VERBS),
    /**
     * A range that could have come from a real selection. `end > start`
     * because a collapsed caret replaces nothing (the request schema refuses
     * one too, and this is the half a hand-written INSERT cannot skip), and a
     * non-negative start because an offset is a position in a string.
     *
     * The upper bound is deliberately absent: it is the CURRENT body's length,
     * which changes without this table being touched, so the only place it can
     * be checked is the request that reads that body.
     */
    check(
      "refine_proposals_range_check",
      sql`${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`,
    ),
  ],
);
