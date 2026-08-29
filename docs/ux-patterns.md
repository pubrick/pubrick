# Pubrick UX Patterns Dossier

**Status:** research complete, August 2026. This document is the
interaction-pattern layer that sits on top of the fixed design direction
(restrained Apple-style tool, sidebar shell + bottom tab bar on mobile,
one-place rule, single "Advanced" disclosure, five status colors, teaching
empty states — see `docs/superpowers` spec in the origin repo and the design
canvas). Nothing here relitigates that direction; everything here is about
the mechanics of screens. It is the foundation for feature design going
forward: when a roadmap feature is specced, start from its patterns here.

**Verdicts:** `ADOPT-NOW` (fits current screens) · `ADOPT-WITH-FEATURE`
(belongs to a named roadmap item) · `REJECTED` (with reason — kept
deliberately, to prevent future bikeshedding).

---

## 1. Queue & scheduling model

### 1.1 Slot-based queue, not date-picker-first (Buffer) — `ADOPT-NOW`

Buffer's core object is a **posting schedule**: recurring weekly time slots
per channel; each slot holds one post. "Add to queue" drops the post into
the next free slot — the user almost never picks a date/time manually
([posting schedules](https://support.buffer.com/en-us/articles/setting-up-your-timezones-and-posting-schedules-P4iSag90Fl),
[scheduling posts](https://support.buffer.com/en-us/articles/scheduling-posts-4Qdld7giAZ)).
This converts "when should I post this?" (a decision per post) into "what's
my cadence?" (a decision made once).

**Mapping:** after approval the primary action is **"Add to queue"**
(auto-slot), with "Pick date & time…" secondary. The per-channel weekly slot
grid lives in Channel settings (one-place rule). Timezone is a property of
the channel, not of the post.

### 1.2 The queue as a reorderable list with "next up" semantics (Buffer, Typefully) — `ADOPT-NOW`

The queue is a chronological list where dragging a post re-slots it; times
stay fixed, content flows through slots. Typefully reviewers single out that
queue + drafts makes it "easier to publish confidently and consistently"
([Efficient App](https://efficient.app/apps/typefully),
[Product Hunt reviews](https://www.producthunt.com/products/typefully/reviews)).

**Mapping:** Queue = one list per brand, grouped by day, drag to reorder. No
queue-pause/shuffle sub-features at v1.

### 1.3 "Best time" as highlighted slots, never a black box (Later) — `ADOPT-WITH-FEATURE` (analytics)

Later computes suggested times from the user's own engagement and simply
**highlights those hours** in the weekly calendar
([the science behind best time to post](https://later.com/blog/the-science-behind-best-time-to-post-and-how-were-making-it-smarter/)).
The praised part is the presentation: a suggestion the user can ignore. The
complained-about part everywhere is opacity.

**Mapping:** once analytics ships, render suggested slots as subtle
highlights with a one-line explanation ("your last 30 posts got most
reactions 18:00–20:00"). Never silently move a scheduled post.

### 1.4 Motion-style autonomous rescheduling — `REJECTED`

Motion's AI reshuffles the calendar continuously; 2025–2026 sentiment turned
negative as it grew into a "SuperApp" — users call the autonomy stressful
([review roundup](https://hirekai.ai/blog/motion-app-review)). **Reason:**
pubrick's covenant is "the machine proposes, the human disposes." Autopilot
may *propose* re-slots as review-queue items; it may never execute them.

---

## 2. Composer & per-channel adaptation

### 2.1 One master draft, per-channel tabs that fork only what's edited (Typefully) — `ADOPT-NOW`

Write once; channel toggles in the composer; editing under a channel toggle
**forks only that channel's copy** while others keep following the master
([Typefully LinkedIn cross-post](https://support.typefully.com/en/articles/8718168-publish-cross-post-to-linkedin),
[Kleo review](https://kleo.so/blog/typefully-review)).

**Mapping:** Compose = master text + a channel tab strip. AI adaptation
fills each tab; a human edit pins the tab (visible "customized" dot).
"Reset to adaptation" per tab. This is already pubrick's data model
(post → per-channel adaptations) — the tab-with-pin is its canonical UI.

### 2.2 Pixel-honest per-channel preview (Typefully, Planable) — `ADOPT-NOW`

Typefully maintains previews that "match how the apps actually look today"
([changelog](https://typefully.com/changelog)); Planable renders the post
"exactly as it would look" per network
([feed view](https://help.planable.io/hc/en-us/articles/21715324442908-View-content-in-the-feed-view)).
Honest previews are what let non-experts approve confidently — the preview
*is* the approval artifact.

**Mapping:** every channel tab shows a live preview (Telegram bubble with
entities rendered, VK card, …). Length limits as a quiet counter that turns
the warning color only when exceeded. Scope limit: preview the *post*, not a
simulated newsfeed (see 2.4).

### 2.3 Distraction-free editor body (Typefully, Lex, iA Writer lineage) — `ADOPT-NOW`

Typefully's editor "strips away everything except your words" — its single
most-praised trait ([Efficient App](https://efficient.app/apps/typefully));
Lex keeps "no overwhelming menus, just you and your text"
([Gold Penguin](https://goldpenguin.org/blog/introducing-lex-page-ai/)).

**Mapping:** Compose's writing surface carries zero persistent toolbars;
formatting and AI live behind selection affordances and `⌘K`.

### 2.4 Full social-network cosplay (fake newsfeed chrome, Planable) — `REJECTED`

Rendering a whole fake newsfeed with cover photo/profile chrome is
decoration; the informational payload is the post preview itself. Violates
restraint and doubles maintenance per network
([SocialRails review](https://socialrails.com/blog/planable-review)).

### 2.5 Built-in Canva-like design studio (Postiz) — `REJECTED`

Scope creep with a giant maintenance tail
([Elestio overview](https://blog.elest.io/postiz-free-open-source-social-media-scheduler/)).
Pubrick attaches media; it does not author it.

---

## 3. Review queue (the moderation heart of pubrick)

### 3.1 Superhuman-style keyed triage: one item, one decision, next — `ADOPT-NOW`

`J/K` to move, single-key decisions, inbox processed one item at a time to
zero; "every action is near-instant" is the core of every positive review
([clean.email review](https://clean.email/blog/email-clients/superhuman-review),
[Superhuman on triage](https://blog.superhuman.com/email-triage/)).

**Mapping (concrete keymap):** `J`/`K` next/prev · `↵` open · `A` approve
(next slot) · `E` edit-then-approve · `R` regenerate (opens the §5.2 loop) ·
`X` reject · `H` snooze · `⌘K` everything else. The queue auto-advances
after any decision. The "all clear" empty state teaches autopilot settings.

### 3.2 A small closed verdict grammar (Linear Triage) — `ADOPT-NOW`

Linear's Triage has exactly four verdicts; "needs more info" is a comment +
snooze, not a fifth state ([Triage docs](https://linear.app/docs/triage)).

**Mapping:** pubrick's verdicts are Approve / Edit / Regenerate / Reject /
Snooze — five, closed, no custom workflow states in v1.

### 3.3 Snooze that returns on time **or** on new activity (Linear) — `ADOPT-NOW`

Linear's snooze returns "at a time of your choosing, or when there's new
activity — whichever comes first" ([Triage docs](https://linear.app/docs/triage)).

**Mapping:** snooze offers Tonight / Tomorrow / Next week / Before its slot;
a snoozed item force-returns when `now + 24h > scheduled_at` (a post never
silently misses its slot) and when the AI produces a new version of it.

### 3.4 Split queue sections, drained separately (Superhuman) — `ADOPT-WITH-FEATURE` (autopilot)

([Split Inbox](https://blog.superhuman.com/how-to-split-your-inbox-in-superhuman/)).
**Mapping:** when autopilot lands, fixed (not user-configurable) sections:
"AI drafted while you were away" / "awaiting client" / "failed & needs
attention". The failure section always sorts first.

### 3.5 Guarded bulk actions (Planable List view) — `ADOPT-NOW` (narrow)

([List view](https://help.planable.io/hc/en-us/articles/21715232507036-List-view)).
**Mapping:** multi-select with exactly two bulk verbs: Approve and Reject.
Bulk Approve prompts once with a count ("Approve 6 posts you haven't
opened?") — bulk approval of unread AI content is how slop ships.

### 3.6 Quick capture + natural-language dates (Things 3) — `ADOPT-NOW`

The global quick-entry with natural-language parsing is repeatedly called
the most practically useful feature in any Mac task manager
([Things support](https://culturedcode.com/things/support/articles/9780167/),
[toolstack](https://toolstack.io/tools/things-3)).

**Mapping:** a global "New idea" capture (`C` anywhere) that accepts one
line + an optional natural-language date and lands it in Drafts — capture
never requires opening the full composer.

---

## 4. Calendar & planning

### 4.1 Keyboard-first calendar (Notion Calendar) — `ADOPT-NOW` (subset)

([design review](https://blakecrosley.com/guides/design/notion-calendar),
[Efficient App](https://efficient.app/apps/notion-calendar)).
**Mapping:** `W`/`M` week/month, arrow-key navigation, drag-to-reschedule
snapping to slots. Skip the 1–9 elastic day views (restraint).

### 4.2 Drag-reschedule + an unscheduled "Ready" rail (Later, Postiz) — `ADOPT-NOW`

([Later visual planner](https://later.com/instagram-scheduler/visual-instagram-planner/)).
The load-bearing part is the backlog rail: approved-but-unscheduled posts
visible beside the calendar, draggable onto a day.

**Mapping:** Calendar = month/week grid + a right-hand "Ready" rail.
Dropping onto a day takes that day's next free slot. Mobile: rail becomes a
bottom sheet.

### 4.3 Calendar chip density: status dot + channel glyph + title, nothing else — `ADOPT-NOW`

([Planable calendar](https://help.planable.io/hc/en-us/articles/21715383136924-Calendar-view),
[Notion UX review](https://adamfard.com/blog/notion-ux-review)).
Month view answers "is the week balanced?"; week view answers "what goes out
when?". No thumbnails in month view.

### 4.4 Instagram-style grid preview (Later) — `REJECTED` (until an IG-class channel exists)

A view with no honest data referent is decoration.

---

## 5. AI in the editor

### 5.1 AI lives in selection + command, never in persistent chrome — `ADOPT-NOW`

Notion's inline mechanic is right; Notion's ambient *triggers* (spacebar,
hover buttons, floating icon) are widely hated — whole guides exist on
stripping them out ([disable AI in Notion](https://keycorrect.com/blog/disable-ai-in-notion)).
Lex shows the calm alternative: AI summoned by explicit command only
([techforword](https://www.techforword.com/blog/best-ai-word-processor-writing-tips)).

**Mapping:** AI appears in exactly two places: the selection toolbar
("Refine…") and `⌘K`. Refine verbs are domain-specific: shorten, adapt tone
to brand, tighten hook, translate. No hover sparkles, no spacebar hijack.

**Amendment — whole-draft generation (2026-08-28, generation engine
increment 1).** This pattern governs the **refinement of existing text**. What
it rejects is ambient solicitation while a person is writing, which is why its
two places are both editor affordances: a selection, and a command over the
draft in front of you.

Generating a whole draft from a brief is not refinement, and it cannot be
editor chrome — at the moment it is invoked there is no text to refine. It is a
compose-time **input**, and it lives where the compose screen's other inputs
live: a brief field above the body with a **secondary** Generate beside it,
while "Create post" remains the screen's one primary action. It is summoned,
never soliciting — §10's third anti-pattern holds: no sparkle, no hover, and
with no AI key configured the action is absent entirely rather than present and
disabled. Generate does not fill the form — it discards the typed draft and
starts a run that lands a different item minutes later, so a non-empty body is
confirmed first.

So AI now appears in three places, not two: the selection toolbar, `⌘K`, and
the compose brief. Inside the editor it is still the two. §5.2's staging rule is
untouched by this: a run lands a `draft`, and approval remains the explicit
human act.

### 5.2 The staging loop: Accept / Try again / Discard (Notion AI) — `ADOPT-NOW`

Generated text always lands in a staging state with explicit
accept/retry/discard — never directly in the document
([walkthrough](https://allthings.how/how-to-use-notion-ai/),
[Shape of AI: Regenerate](https://www.shapeof.ai/patterns/regenerate)).
Guided regeneration ("Try again: shorter / more formal") beats blank
re-prompting.

**Mapping:** every AI proposal renders as a proposal card with Accept / Try
again (with quick modifiers) / Discard. Accept is always an explicit human
act — the load-bearing anti-slop affordance.

### 5.3 Authorship provenance: AI text is visibly AI until a human touches it (iA Writer) — `ADOPT-NOW` (pubrick's signature)

iA Writer renders AI-originated words in grey and human words in black,
tracked through edits ([Authorship](https://ia.net/writer/support/editor/authorship),
[iA Writer 7](https://ia.net/topics/ia-writer-7)). No scheduler on the
market does this.

**Mapping:** coarse-grain provenance: an **origin badge** on every
queue/calendar card (AI-drafted / AI-adapted / human-written / human-edited)
and an editor toggle dimming still-untouched AI sentences. Enables the
honest rule: nothing publishes with zero human edits AND zero human
read-time. This is a differentiator; invest here.

**Shipped decision: the lens is off by default.** The editor toggle that dims
still-AI sentences starts off, and that is a choice rather than a leftover.
This section argues for on (AI text is *visibly* AI); §2.3 keeps the writing
surface calm and argues for off. What breaks the tie is that the claim is
already being made elsewhere: the origin badge states it at a glance on every
card and on the item screen, with no interaction and nothing added to the
editor. The lens is the detail view — *which* sentences, not *whether* — so it
is opt-in, per screen, and never on at the moment a person sits down to write.
The trade accepted with it: a writer who never finds the toggle sees the badge
and not the sentences. All four badge values DO reach the card — the list
endpoint returns `bodyIsAiVerbatim`, a verdict rather than the version text —
because "the badge already carries the claim on every card" is the argument, so
it had to be true; a card that read *AI-drafted* for a body the item screen
called *human-edited* would be a worse untruth than the one the lens removes.
Revisit the default as a per-user preference rather than by flipping it, and
revisit it deliberately — if the badge ever stops being on every card, the
argument above no longer holds. When the lens IS on, a short legend says
what dim means: without it, "nothing is dimmed" cannot be told apart from
"the highlighting is broken". The legend also owns the one place the badge and
the lens visibly disagree — a deleted sentence is an edit the dimming has
nothing left to show, so the badge can read *human-edited* while every visible
sentence is dimmed. (Provenance-lens design §5; the default itself is
one `useState(false)` in `app/[locale]/content/[id]/page.tsx`.)

### 5.4 Brand voice as a named, per-brand object (Jasper) — `ADOPT-WITH-FEATURE` (brand knowledge)

([Brand Voice](https://www.jasper.ai/blog/introducing-brand-voice),
[ohaiknow review](https://ohaiknow.com/reviews/jasper/)).
**Mapping:** per-brand "Voice & Knowledge" section: voice description
(editable text, not a black box), example posts, banned phrases, product
facts. Every generation cites which knowledge chunks it used. Plain settings
page + citations popover — no "AI studio".

### 5.5 Always-on AI prose checks (Lex's pink flags) — `REJECTED` (v1)

Good in a prose tool; for short social posts it is noise and violates the
calm-editor rule. The same value is delivered by refine verbs on demand.
Revisit only as an opt-in pre-publish check.

---

## 6. Publishing reliability & failure surfacing

*(The loudest complaint cluster in the whole category — this is where
pubrick wins trust or dies.)*

### 6.1 Failures are loud, in-app, and actionable — `ADOPT-NOW`

The category's chronic sin is silent failure: expired tokens kill publishing
quietly; documented nine-day outages discovered by accident
([token-expiry silent breaks](https://onetwothreesend.com/social-media-automation-token-expiry-silent-breaks/)).
Buffer's one good mechanic: a failed post offers exactly two recoveries
([retry](https://support.buffer.com/article/649-posts-failing-to-save-due-to-server-issues));
it also maintains per-network human-readable error libraries
([example](https://support.buffer.com/article/579-twitter-error-library)).

**Mapping:** a failed publish turns the post the error color everywhere it
appears and pushes a Needs-attention item that always sorts first. The card
shows the human-readable cause and two buttons: Retry now / Re-slot. After a
channel reconnect, pubrick **offers** "Retry 4 failed posts?" — one click,
never automatic. Failure notifications are ON by default.

### 6.2 Channel-health surfacing before failure — `ADOPT-NOW`

No tool shows connection health proactively; reconnect-your-account is every
scheduler's most common support answer
([LinkedIn failures roundup](https://postplanify.com/blog/linkedin-scheduled-posts-not-working)).

**Mapping:** Channels screen shows a health dot per connection (ok /
expiring soon / broken); a degrading channel generates a Needs-attention
item while the queue can still be saved: "Telegram bot token invalid — 3
scheduled posts at risk."

### 6.3 CI-style delivery receipt on the post detail — `ADOPT-NOW`

A run = an ordered list of steps, each with status, timestamp, expandable
detail ([GitHub Actions lineage](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows)).

**Mapping:** post detail gets a per-channel "delivery" section: adapted →
approved (by whom) → queued (slot) → published (link) → metrics collected;
a failed step expands to the raw API error. One component = audit log,
debugging tool and client-facing proof.

---

## 7. Autopilot & oversight (roadmap)

### 7.1 "While you were away" digest inside the product's own inbox (Linear Pulse) — `ADOPT-WITH-FEATURE`

([Pulse](https://linear.app/changelog/2025-04-16-pulse)). The digest lives
in the tool's existing inbox and links every line to the underlying object.

**Mapping:** the Review Queue opens (after absence) with a collapsible
digest header: "While you were away: watched 14 sources, drafted 5 posts
(below), skipped 2 (reasons), published 3 previously-approved (links)."
Pulse's audio version — `REJECTED`, novelty surface.

### 7.2 Risk-tiered autonomy instead of approve-everything — `ADOPT-WITH-FEATURE`

2026 HITL consensus: classify actions by reversibility; gate only
consequential ones; approval fatigue turns humans into rubber stamps
([Atlassian HITL](https://www.atlassian.com/software/jira/guides/agentic-engineering/human-in-the-loop),
[escalation design](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026)).

**Mapping:** per-brand autonomy ladder, one setting: (1) draft only →
(2) draft + auto-queue with an N-hour review window → (3) auto-publish for
whitelisted low-risk formats only. Reads never ask permission. The UI shows
*why* an item required approval.

### 7.3 The undo toast + review window pair (Gmail Undo Send) — undo `ADOPT-NOW`, window `ADOPT-WITH-FEATURE`

([LogRocket on reversible actions](https://blog.logrocket.com/ux-design/ux-reversible-actions-framework/)).

**Mapping:** seconds scale (now): "Publish now" shows a 10-second
"Publishing… Undo" toast before the API call fires. Hours scale (autopilot):
auto-queued posts carry a countdown chip; the window IS the oversight.

### 7.4 Append-only per-brand activity feed — `ADOPT-WITH-FEATURE`

([agent transparency patterns](https://aiuxplayground.com/guides/designing-ai-agents/)).
**Mapping:** a flat, filterable log (human and AI actions interleaved,
actor-badged) under Brand → Activity. A page, not a widget on every screen.

### 7.5 Performance-conditional automation chains (FeedHive) — `REJECTED`

"If post gets >X likes, auto-post a follow-up" — even fans find the related
automation "convoluted" ([Capterra](https://www.capterra.com/p/240356/FeedHive/reviews/)).
Invisible content-producing triggers are the exact failure mode our
oversight design prevents. The same need is served by autopilot *proposing*
a follow-up into the Review Queue.

---

## 8. Client approval (roadmap)

### 8.1 No-login external review link with a stripped view (Planable) — `ADOPT-WITH-FEATURE`

([approval workflows](https://help.planable.io/hc/en-us/articles/21715462785180-Approvals-and-Approval-Workflows)).
**Mapping:** client link = one mobile-friendly page per approval batch:
honest per-channel previews, per-post Approve / Request changes + comment,
progress header. No account, no navigation shell.

### 8.2 Per-item verdicts; approve-all only as a confirmed shortcut — `ADOPT-WITH-FEATURE`

**Mapping:** per-item verdicts are canonical; "Approve all remaining"
confirms with a count and marks items "approved in bulk" in the activity
log.

### 8.3 Version-anchored feedback + inline diff (Filestage) — `ADOPT-WITH-FEATURE`

([version control](https://filestage.io/document-version-control-software/)).
**Mapping:** after an edit, the client link shows "v2 — updated after your
feedback" with a collapsed text diff; comments stay anchored to their
version. Skip side-by-side compare (posts are short).

### 8.4 Approval lock + one-click nudge (Planable) — `ADOPT-WITH-FEATURE`

**Mapping:** an approved post's text becomes read-only; editing requires
"Reopen (drops approval)" — explicit and logged. Waiting-on-client posts
show a quiet "Remind" button after 48h.

### 8.5 Multi-level sequential approval chains — `REJECTED` (v1)

Workflow-builder complexity for a segment that is not the first audience;
one internal approval + one optional client approval covers the 90% case.

---

## 9. Results / analytics (brief)

- **Per-post results live on the post**, not only in a dashboard — the #1
  analytics complaint about the category is shallow, disconnected analytics
  ([Efficient App on Buffer](https://efficient.app/apps/buffer)).
  `ADOPT-NOW`: the delivery receipt (§6.3) ends with the metrics row; the
  Results screen aggregates the same objects.
- **Results feed the loop visibly:** best-time highlights (§1.3) and
  follow-up proposals must cite the metric that triggered them.
  `ADOPT-WITH-FEATURE`.

---

## 10. Anti-patterns (the do-not list)

1. **Silent publish failures / opt-in failure alerts.** Failure
   notifications on by default; failures sort first.
2. **Token death as a support ticket instead of a UI state.** Channel
   health is proactive (§6.2).
3. **Ambient AI solicitation.** AI must be summoned, never soliciting
   (Notion's spacebar-AI spawned "how to remove AI" guides).
4. **Feature-bloat drift ("SuperApp" syndrome).** The REJECTED entries in
   this dossier are the fence; Motion is the cautionary tale.
5. **Approval fatigue by over-gating.** Tier the autonomy; never gate
   reads.
6. **Black-box suggestions.** Every suggestion carries a one-line reason.
7. **Safety features gated behind an edition.** For OSS pubrick: failure
   alerts, approval and provenance are never edition-gated.
8. **AI text reaching "queued" without an explicit human Accept** (§5.2)
   plus provenance (§5.3). Any pipeline that allows it will ship slop.

---

## 11. Pattern index

| # | Pattern | Source | Verdict | Target |
|---|---|---|---|---|
| 1.1 | Slot-based queue | Buffer | adopt-now | Schedule/Channels |
| 1.2 | Reorderable queue list | Buffer/Typefully | adopt-now | Queue |
| 1.3 | Explained best-time highlights | Later | adopt-with-feature | Analytics |
| 1.4 | Autonomous rescheduling | Motion | **rejected** | — |
| 2.1 | Master draft + forked channel tabs | Typefully | adopt-now | Compose |
| 2.2 | Pixel-honest channel preview | Typefully/Planable | adopt-now | Compose/Review |
| 2.3 | Chrome-free editor | Typefully/Lex | adopt-now | Compose |
| 2.4 | Fake-newsfeed cosplay | Planable | **rejected** | — |
| 2.5 | Built-in design studio | Postiz | **rejected** | — |
| 3.1 | J/K/A/E/R/X/H keyed triage | Superhuman | adopt-now | Review Queue |
| 3.2 | Closed verdict grammar | Linear Triage | adopt-now | Review Queue |
| 3.3 | Snooze-until-time-or-activity | Linear | adopt-now | Review Queue |
| 3.4 | Fixed queue sections | Superhuman | adopt-with-feature | Autopilot |
| 3.5 | Guarded bulk approve | Planable | adopt-now | Review Queue |
| 3.6 | Quick capture + NL dates | Things 3 | adopt-now | Global |
| 4.1 | Keyboard-first calendar | Notion Calendar | adopt-now (subset) | Calendar |
| 4.2 | Drag-reschedule + Ready rail | Later/Postiz | adopt-now | Calendar |
| 4.3 | Minimal status-chip density | Planable/Notion | adopt-now | Calendar |
| 4.4 | IG grid preview | Later | **rejected** (until IG) | — |
| 5.1 | AI via selection + ⌘K (refinement only — see the §5.1 amendment) | Notion (mechanic), Lex (trigger) | adopt-now | Compose |
| 5.2 | Accept/Try-again/Discard staging | Notion AI | adopt-now | Compose/Review |
| 5.3 | AI authorship provenance | iA Writer | adopt-now (signature) | Everywhere |
| 5.4 | Per-brand voice & knowledge object | Jasper | adopt-with-feature | Brand knowledge |
| 5.5 | Always-on AI prose checks | Lex | **rejected** (v1) | — |
| 6.1 | Loud failures, 2-button recovery | Buffer + category inversion | adopt-now | Queue/Channels |
| 6.2 | Channel-health preflight | (category gap) | adopt-now | Channels |
| 6.3 | CI-style delivery receipt | GitHub Actions lineage | adopt-now | Post detail |
| 7.1 | In-app "while away" digest | Linear Pulse | adopt-with-feature | Autopilot |
| 7.1b | Audio digest | Linear Pulse | **rejected** | — |
| 7.2 | Risk-tiered autonomy ladder | HITL 2026 consensus | adopt-with-feature | Autopilot |
| 7.3 | Undo toast + review window | Gmail | adopt-now / with-feature | Publish/Autopilot |
| 7.4 | Per-brand activity log | agent-UX patterns | adopt-with-feature | Brand |
| 7.5 | Performance-triggered auto-chains | FeedHive | **rejected** | — |
| 8.1 | No-login client review link | Planable | adopt-with-feature | Client approval |
| 8.2 | Per-item verdicts, confirmed approve-all | Planable/Filestage | adopt-with-feature | Client approval |
| 8.3 | Version-anchored feedback + diff | Filestage | adopt-with-feature | Client approval |
| 8.4 | Approval lock + nudge | Planable | adopt-with-feature | Client approval |
| 8.5 | Multi-level approval chains | Planable Enterprise | **rejected** (v1) | — |
