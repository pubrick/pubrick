import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invitation, user } from "./auth.js";

/** Short-lived account abuse claims survive workspace deletion, never store mail or secrets. */
export const hostedAccountCreationClaims = pgTable(
  "hosted_account_creation_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("hosted_account_creation_user_time_idx").on(t.userId, t.createdAt),
    index("hosted_account_creation_time_idx").on(t.createdAt),
  ],
);

/** Binds replay of a consumed invitation to its original verified recipient. */
export const hostedInvitationAcceptances = pgTable("hosted_invitation_acceptances", {
  invitationId: text("invitation_id")
    .primaryKey()
    .references(() => invitation.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
});
