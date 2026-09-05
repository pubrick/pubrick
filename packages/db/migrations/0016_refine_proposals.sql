-- 0016 — the server holds the refine proposal a person is reading.
--
-- WHY A TABLE. Accepting a refine writes a `content_versions` row saying
-- `origin = 'ai'` about the text — the product's evidence that a MODEL wrote
-- those sentences, which the lens dims, the badge captions "AI-drafted" and
-- the publish gate counts as text nobody has had to read. Were Accept to take
-- that text from its caller, any caller could author that evidence about words
-- a person typed. So the proposal is written HERE, by the request that paid
-- for it, and Accept reads the row back.
--
-- ONE ROW PER DRAFT, and the unique index is what makes "at most one staged
-- proposal per screen" a constraint instead of a hope. The next propose
-- deletes and re-inserts in one transaction, so pressing Refine again
-- supersedes rather than accumulates.
--
-- NO LEASE, NO EXPIRY, NO SWEEPER, and that is a decision. A lease bounds work
-- whose end nobody observes; a refine is one synchronous request with a
-- wall-clock budget, observed by the process that started it. A row orphaned
-- by a crashed request blocks nothing, because the next propose replaces it,
-- and the MONEY is bounded elsewhere — by a rolling count of the
-- `usage_ledger` rows the calls themselves wrote.
--
-- WHAT IS CHECKED, AND WHAT DELIBERATELY IS NOT. `verb` is pinned to
-- `REFINE_VERBS` in the database as well as in the types, like every other
-- enum column here: the verb decides which fixed role lines a call was made
-- with. The offsets are checked for the two things that are true of any real
-- selection — a non-negative start, and an end past it, so a collapsed caret
-- cannot be stored as a selection that replaces nothing.
--
-- There is NO `end_offset - start_offset = length(selected_text)` constraint,
-- and its absence is the point rather than an omission: Postgres `length()`
-- counts code POINTS while these offsets are UTF-16 code units, the unit every
-- JavaScript string offset is measured in. The two disagree on every emoji —
-- ordinary social copy — so that constraint would refuse exactly the posts
-- this product is for. There is no upper bound on the offsets either: the
-- bound is the CURRENT body's length, which changes without this table being
-- touched, so only the request that reads that body can check it.
--
-- ADDITIVE. One new table, three foreign keys, two indexes. Nothing existing
-- is read, rewritten or constrained, so this file is valid against a database
-- holding rows in every table it references.
CREATE TABLE "refine_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"created_by" text,
	"verb" text NOT NULL,
	"selected_text" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"proposal" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refine_proposals_verb_check" CHECK ("refine_proposals"."verb" in ('shorten', 'warmer', 'punchier')),
	CONSTRAINT "refine_proposals_range_check" CHECK ("refine_proposals"."start_offset" >= 0 and "refine_proposals"."end_offset" > "refine_proposals"."start_offset")
);
--> statement-breakpoint
ALTER TABLE "refine_proposals" ADD CONSTRAINT "refine_proposals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refine_proposals" ADD CONSTRAINT "refine_proposals_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refine_proposals" ADD CONSTRAINT "refine_proposals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refine_proposals_org_id_idx" ON "refine_proposals" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refine_proposals_content_item_id_idx" ON "refine_proposals" USING btree ("content_item_id");