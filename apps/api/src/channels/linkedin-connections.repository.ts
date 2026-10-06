import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { schema, withTenantResourceAdmissionWithHeldLocks } from "@pubrick/db";
import {
  decryptJson,
  encryptJson,
  isOrganizationManager,
  LINKEDIN_AUTHORIZATION_TTL_SECONDS,
  LINKEDIN_MAX_AUTHORIZATION_REQUESTS,
  type LinkedInAuthorizationStart,
  RUN_ADMISSION_LOCK_NAMESPACE,
} from "@pubrick/shared";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { conflict, forbidden, notFound } from "../api-error";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";
import { tenantQuotaMode, withQuotaErrors } from "../tenant-quota";
import type { LinkedInOAuthAuthorization, LinkedInOAuthConnection } from "./linkedin-oauth-client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const STATE_COLUMNS = {
  id: schema.linkedinAuthorizationRequests.id,
  brandId: schema.linkedinAuthorizationRequests.brandId,
  userId: schema.linkedinAuthorizationRequests.userId,
  sessionId: schema.linkedinAuthorizationRequests.sessionId,
  nonceEncrypted: schema.linkedinAuthorizationRequests.nonceEncrypted,
  channelId: schema.linkedinAuthorizationRequests.channelId,
  expectedGeneration: schema.linkedinAuthorizationRequests.expectedGeneration,
  expectedTarget: schema.linkedinAuthorizationRequests.expectedTarget,
  name: schema.linkedinAuthorizationRequests.name,
  locale: schema.linkedinAuthorizationRequests.locale,
};
type AuthorizationRequest = typeof schema.linkedinAuthorizationRequests.$inferSelect;
export type ConsumedLinkedInAuthorization = Pick<AuthorizationRequest, keyof typeof STATE_COLUMNS>;

function stateHash(state: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(state))
    throw conflict("linkedin_authorization_invalid", "Start a new LinkedIn connection request");
  return createHash("sha256").update(state).digest("hex");
}
function actorFor(orgId: string) {
  const actor = currentRequestAuthority();
  if (actor?.kind !== "session" || actor.orgId !== orgId)
    throw forbidden("linkedin_authority_changed", "A current manager session is required");
  return actor;
}

@Injectable()
export class LinkedInConnectionsRepository {
  private async admission(tx: Tx, orgId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
    );
    await holdOrganization(tx, orgId);
  }

  /** Recheck persisted session and manager roles; retain compatible locks only for this short write. */
  private async authorize(tx: Tx, orgId: string, brandId: string) {
    const actor = actorFor(orgId);
    if (actor.brandId !== undefined && actor.brandId !== brandId)
      throw forbidden("linkedin_authority_changed", "The authorized brand changed");
    if (!(await authorizeRequestActor(tx, orgId)))
      throw forbidden("linkedin_authority_changed", "Session or organization access changed");
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .for("key share");
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    const members = await tx
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actor.userId)))
      .orderBy(asc(schema.member.id))
      .for("share");
    if (!isOrganizationManager(members.map((member) => member.role).join(",")))
      throw forbidden("linkedin_authority_changed", "Organization owner or admin required");
    return actor;
  }

  private async currentSession(tx: Tx, orgId: string) {
    const actor = actorFor(orgId);
    const [session] = await tx
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(
        and(
          eq(schema.session.id, actor.sessionId),
          eq(schema.session.userId, actor.userId),
          eq(schema.session.activeOrganizationId, orgId),
          sql`${schema.session.expiresAt} > clock_timestamp()`,
        ),
      );
    if (!session) throw forbidden("linkedin_authority_changed", "The session expired; start again");
  }

  private async channel(tx: Tx, orgId: string, brandId: string, id: string, generation: number) {
    const [channel] = await tx
      .select({
        id: schema.channels.id,
        platform: schema.channels.platform,
        generation: schema.channels.connectionGeneration,
        target: schema.channels.connectionTarget,
      })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          eq(schema.channels.id, id),
        ),
      )
      .for("no key update");
    if (channel?.platform !== "linkedin")
      throw notFound("channel_not_found", "LinkedIn channel not found");
    if (channel.generation !== generation)
      throw conflict(
        "linkedin_connection_changed",
        "The connection changed; reload before reconnecting",
      );
    return channel;
  }

  async start(
    orgId: string,
    intent: LinkedInAuthorizationStart,
    authorization: LinkedInOAuthAuthorization,
  ) {
    const hash = stateHash(authorization.state);
    const nonceEncrypted = encryptJson({ nonce: authorization.nonce }, env.APP_ENCRYPTION_KEY);
    await db.transaction(async (tx) => {
      await this.admission(tx, orgId);
      const actor = await this.authorize(tx, orgId, intent.brandId);
      const channel =
        intent.channelId !== undefined && intent.expectedGeneration !== undefined
          ? await this.channel(
              tx,
              orgId,
              intent.brandId,
              intent.channelId,
              intent.expectedGeneration,
            )
          : null;
      await tx
        .delete(schema.linkedinAuthorizationRequests)
        .where(
          and(
            eq(schema.linkedinAuthorizationRequests.orgId, orgId),
            sql`${schema.linkedinAuthorizationRequests.expiresAt} <= clock_timestamp()`,
          ),
        );
      const [capacity] = await tx
        .select({ count: sql<number>`count(*)::integer`.mapWith(Number) })
        .from(schema.linkedinAuthorizationRequests)
        .where(eq(schema.linkedinAuthorizationRequests.orgId, orgId));
      if (
        (capacity?.count ?? LINKEDIN_MAX_AUTHORIZATION_REQUESTS) >=
        LINKEDIN_MAX_AUTHORIZATION_REQUESTS
      )
        throw conflict(
          "linkedin_authorization_capacity",
          "Wait for earlier LinkedIn requests to expire before starting again",
        );
      await this.currentSession(tx, orgId);
      const createdAt = new Date();
      await tx.insert(schema.linkedinAuthorizationRequests).values({
        orgId,
        brandId: intent.brandId,
        userId: actor.userId,
        sessionId: actor.sessionId,
        stateHash: hash,
        nonceEncrypted,
        channelId: channel?.id ?? null,
        expectedGeneration: channel?.generation ?? null,
        expectedTarget: channel?.target ?? null,
        name: intent.name,
        locale: intent.locale,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + LINKEDIN_AUTHORIZATION_TTL_SECONDS * 1000),
      });
    });
  }

  /** Commit consumption before exchanging a code. An interrupted exchange requires a new authorization. */
  async consume(orgId: string, state: string): Promise<ConsumedLinkedInAuthorization> {
    const hash = stateHash(state);
    return db.transaction(async (tx) => {
      await this.admission(tx, orgId);
      const actor = actorFor(orgId);
      const [snapshot] = await tx
        .select(STATE_COLUMNS)
        .from(schema.linkedinAuthorizationRequests)
        .where(
          and(
            eq(schema.linkedinAuthorizationRequests.orgId, orgId),
            eq(schema.linkedinAuthorizationRequests.stateHash, hash),
            eq(schema.linkedinAuthorizationRequests.userId, actor.userId),
            eq(schema.linkedinAuthorizationRequests.sessionId, actor.sessionId),
            isNull(schema.linkedinAuthorizationRequests.consumedAt),
            sql`${schema.linkedinAuthorizationRequests.expiresAt} > clock_timestamp()`,
          ),
        );
      if (!snapshot)
        throw conflict(
          "linkedin_authorization_invalid",
          "This authorization request expired or was already used",
        );
      await this.authorize(tx, orgId, snapshot.brandId);
      if (snapshot.channelId !== null && snapshot.expectedGeneration !== null) {
        const channel = await this.channel(
          tx,
          orgId,
          snapshot.brandId,
          snapshot.channelId,
          snapshot.expectedGeneration,
        );
        if (channel.target !== snapshot.expectedTarget)
          throw conflict("channel_target_changed", "The channel destination changed");
      }
      await this.currentSession(tx, orgId);
      const [consumed] = await tx
        .update(schema.linkedinAuthorizationRequests)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.linkedinAuthorizationRequests.orgId, orgId),
            eq(schema.linkedinAuthorizationRequests.id, snapshot.id),
            eq(schema.linkedinAuthorizationRequests.userId, actor.userId),
            eq(schema.linkedinAuthorizationRequests.sessionId, actor.sessionId),
            isNull(schema.linkedinAuthorizationRequests.consumedAt),
            sql`${schema.linkedinAuthorizationRequests.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning(STATE_COLUMNS);
      if (!consumed)
        throw conflict("linkedin_authorization_invalid", "Start a new LinkedIn connection request");
      return consumed;
    });
  }

  nonce(orgId: string, request: ConsumedLinkedInAuthorization): string {
    // orgId first even for this internal helper; never decrypt an unbound browser-supplied record.
    actorFor(orgId);
    try {
      const value = decryptJson<{ nonce?: unknown }>(
        request.nonceEncrypted,
        env.APP_ENCRYPTION_KEY,
      ).nonce;
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value))
        throw new Error("invalid nonce");
      return value;
    } catch {
      throw conflict("linkedin_authorization_invalid", "Start a new LinkedIn connection request");
    }
  }

  async finish(
    orgId: string,
    request: ConsumedLinkedInAuthorization,
    connection: LinkedInOAuthConnection,
  ): Promise<string> {
    return withQuotaErrors(() =>
      db.transaction(async (tx) => {
        await this.admission(tx, orgId);
        const actor = await this.authorize(tx, orgId, request.brandId);
        if (actor.userId !== request.userId || actor.sessionId !== request.sessionId)
          throw forbidden("linkedin_authority_changed", "The acting session changed");
        const channel =
          request.channelId !== null && request.expectedGeneration !== null
            ? await this.channel(
                tx,
                orgId,
                request.brandId,
                request.channelId,
                request.expectedGeneration,
              )
            : null;
        if (
          channel &&
          (channel.target !== request.expectedTarget ||
            channel.target !== connection.credentials.authorUrn)
        )
          throw conflict(
            "channel_target_changed",
            "Reconnect the same personal account; another destination needs a new channel",
          );
        const [state] = await tx
          .select({ id: schema.linkedinAuthorizationRequests.id })
          .from(schema.linkedinAuthorizationRequests)
          .where(
            and(
              eq(schema.linkedinAuthorizationRequests.orgId, orgId),
              eq(schema.linkedinAuthorizationRequests.id, request.id),
              eq(schema.linkedinAuthorizationRequests.userId, actor.userId),
              eq(schema.linkedinAuthorizationRequests.sessionId, actor.sessionId),
              isNotNull(schema.linkedinAuthorizationRequests.consumedAt),
              sql`${schema.linkedinAuthorizationRequests.expiresAt} > clock_timestamp()`,
            ),
          )
          .for("update");
        if (!state)
          throw conflict(
            "linkedin_authorization_invalid",
            "Start a new LinkedIn connection request",
          );
        await this.currentSession(tx, orgId);
        const now = new Date();
        const expiresAt = new Date(connection.credentials.expiresAt);
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)
          throw conflict("linkedin_reconnect_required", "The account token expired; reconnect");
        const values = {
          credentialsEncrypted: encryptJson(connection.credentials, env.APP_ENCRYPTION_KEY),
          connectionAccount: connection.account,
          connectionScopes: connection.credentials.scopes,
          connectionExpiresAt: expiresAt,
          connectionConnectedAt: now,
          connectionDisconnectedAt: null,
          healthOk: true,
          healthCheckedAt: now,
        };
        let channelId: string;
        if (channel) {
          const [saved] = await tx
            .update(schema.channels)
            .set({
              ...values,
              connectionGeneration: sql`${schema.channels.connectionGeneration} + 1`,
            })
            .where(
              and(
                eq(schema.channels.orgId, orgId),
                eq(schema.channels.id, channel.id),
                eq(schema.channels.connectionGeneration, channel.generation),
              ),
            )
            .returning({ id: schema.channels.id });
          if (!saved)
            throw conflict("linkedin_connection_changed", "The connection changed; reload it");
          channelId = saved.id;
        } else {
          channelId = await withTenantResourceAdmissionWithHeldLocks(
            orgId,
            tx,
            { ...tenantQuotaMode(), authorizeActor: authorizeRequestActor },
            { resource: "channels", additional: 1 },
            async (targetTx) => {
              const [saved] = await targetTx
                .insert(schema.channels)
                .values({
                  ...values,
                  orgId,
                  brandId: request.brandId,
                  platform: "linkedin",
                  name: request.name,
                  connectionTarget: connection.credentials.authorUrn,
                  connectionGeneration: 1,
                })
                .returning({ id: schema.channels.id });
              if (!saved) throw new Error("LinkedIn connection could not be retained");
              return saved.id;
            },
          );
        }
        // Remove this already-consumed internal record after the same atomic channel write.
        await tx
          .delete(schema.linkedinAuthorizationRequests)
          .where(
            and(
              eq(schema.linkedinAuthorizationRequests.orgId, orgId),
              eq(schema.linkedinAuthorizationRequests.id, request.id),
            ),
          );
        return channelId;
      }),
    );
  }

  async disconnect(orgId: string, id: string, expectedGeneration: number): Promise<void> {
    const [snapshot] = await db
      .select({ brandId: schema.channels.brandId })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.id, id),
          eq(schema.channels.platform, "linkedin"),
        ),
      );
    if (!snapshot) throw notFound("channel_not_found", "LinkedIn channel not found");
    await db.transaction(async (tx) => {
      await this.admission(tx, orgId);
      await this.authorize(tx, orgId, snapshot.brandId);
      const channel = await this.channel(tx, orgId, snapshot.brandId, id, expectedGeneration);
      await this.currentSession(tx, orgId);
      await tx
        .update(schema.channels)
        .set({
          credentialsEncrypted: null,
          connectionGeneration: sql`${schema.channels.connectionGeneration} + 1`,
          connectionDisconnectedAt: new Date(),
          healthOk: null,
          healthCheckedAt: null,
        })
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.id, channel.id),
            eq(schema.channels.connectionGeneration, expectedGeneration),
          ),
        );
      // Existing jobs, adaptations, target and publication receipts are deliberately retained.
    });
  }
}
