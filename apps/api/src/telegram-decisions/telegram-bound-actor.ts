import { type BillingTransaction, schema } from "@pubrick/db";
import { hasOrganizationRole, isOrganizationManager } from "@pubrick/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { identity } from "../env";
import { holdOrganization } from "../organization-lock";

export type TelegramActorCandidate = Readonly<{
  orgId: string;
  brandId: string;
  userId: string;
  bindingId: string;
  botIdentityId: string;
  generation: number;
  telegramUserId: string;
}>;
export type TelegramBoundActor = Readonly<{
  userId: string;
  bindingId: string;
  privateChatId: string;
}>;

/**
 * Call after secret-authenticated route/capability discovery, before any domain
 * or callback row lock. The candidate is a hint: all authority is reread below.
 * This authorizes an editorial actor, never a synthetic session or API key.
 */
export async function authorizeTelegramBoundActor(
  tx: BillingTransaction,
  candidate: TelegramActorCandidate,
): Promise<TelegramBoundActor | null> {
  const { orgId, userId, brandId } = candidate;
  await holdOrganization(tx, orgId);
  const [user] = await tx
    .select({ verified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .for("share");
  if (!user || (identity.hosted && !user.verified)) return null;
  // Grant replacement holds UPDATE on the brand before member/grant rows.
  const [brand] = await tx
    .select({ id: schema.brands.id })
    .from(schema.brands)
    .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
    .for("share");
  if (!brand) return null;
  const members = await tx
    .select({ id: schema.member.id, role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .orderBy(asc(schema.member.id))
    .for("share");
  const role = members.map((row) => row.role).join(",");
  const manager = isOrganizationManager(role);
  if (!manager && !hasOrganizationRole(role, ["member", "editor"])) return null;
  if (!manager) {
    const grants = await tx
      .select({ memberId: schema.brandAccess.memberId })
      .from(schema.brandAccess)
      .where(
        and(
          eq(schema.brandAccess.orgId, orgId),
          eq(schema.brandAccess.brandId, brandId),
          inArray(
            schema.brandAccess.memberId,
            members.map((row) => row.id),
          ),
        ),
      )
      .orderBy(asc(schema.brandAccess.memberId))
      .for("share");
    if (!grants.length) return null;
  }
  const [bot] = await tx
    .select({ id: schema.telegramBotIdentities.id })
    .from(schema.telegramBotIdentities)
    .where(
      and(
        eq(schema.telegramBotIdentities.id, candidate.botIdentityId),
        eq(schema.telegramBotIdentities.ownerOrgId, orgId),
        eq(schema.telegramBotIdentities.generation, candidate.generation),
        eq(schema.telegramBotIdentities.enabled, true),
        eq(schema.telegramBotIdentities.quarantined, false),
      ),
    )
    .for("share");
  if (!bot) return null;
  const [config] = await tx
    .select({ orgId: schema.telegramDecisionConfigs.orgId })
    .from(schema.telegramDecisionConfigs)
    .where(
      and(
        eq(schema.telegramDecisionConfigs.orgId, orgId),
        eq(schema.telegramDecisionConfigs.botIdentityId, bot.id),
        eq(schema.telegramDecisionConfigs.generation, candidate.generation),
        eq(schema.telegramDecisionConfigs.state, "active"),
      ),
    )
    .for("share");
  if (!config) return null;
  const [binding] = await tx
    .select({ id: schema.telegramBindings.id, chatId: schema.telegramBindings.privateChatId })
    .from(schema.telegramBindings)
    .where(
      and(
        eq(schema.telegramBindings.id, candidate.bindingId),
        eq(schema.telegramBindings.orgId, orgId),
        eq(schema.telegramBindings.userId, userId),
        eq(schema.telegramBindings.botIdentityId, bot.id),
        eq(schema.telegramBindings.generation, candidate.generation),
        eq(schema.telegramBindings.telegramUserId, candidate.telegramUserId),
        eq(schema.telegramBindings.state, "linked"),
      ),
    )
    .for("share");
  return binding ? { userId, bindingId: binding.id, privateChatId: binding.chatId } : null;
}
