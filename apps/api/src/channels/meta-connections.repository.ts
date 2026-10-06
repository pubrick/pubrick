import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { schema, withTenantResourceAdmissionWithHeldLocks } from "@pubrick/db";
import {
  facebookPageCredentialsSchema,
  facebookPageCredentialTarget,
  instagramCredentialTarget,
  instagramNativeCredentialsSchema,
  threadsCredentialsSchema,
  threadsCredentialTarget,
} from "@pubrick/integrations";
import {
  decryptJson,
  encryptJson,
  isOrganizationManager,
  META_AUTHORIZATION_TTL_SECONDS,
  META_MAX_AUTHORIZATION_REQUESTS,
  META_MAX_DISCOVERED_PAGES,
  type MetaAuthorizationStart,
  type MetaConnectionProvider,
  metaAuthorizationCompletedSchema,
  RUN_ADMISSION_LOCK_NAMESPACE,
} from "@pubrick/shared";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../api-error";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";
import { tenantQuotaMode, withQuotaErrors } from "../tenant-quota";
import type { MetaAccountConnection, MetaPageDiscovery } from "./meta-account-client";
import type { MetaRuntimeConfiguration } from "./meta-runtime-config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const requests = schema.metaAuthorizationRequests;
const STATE_COLUMNS = {
  id: requests.id,
  orgId: requests.orgId,
  brandId: requests.brandId,
  provider: requests.provider,
  applicationId: requests.applicationId,
  redirectUri: requests.redirectUri,
  userId: requests.userId,
  sessionId: requests.sessionId,
  channelId: requests.channelId,
  expectedGeneration: requests.expectedGeneration,
  expectedTarget: requests.expectedTarget,
  name: requests.name,
  locale: requests.locale,
  createdAt: requests.createdAt,
  expiresAt: requests.expiresAt,
  consumedAt: requests.consumedAt,
  pageSelectionEncrypted: requests.pageSelectionEncrypted,
  pageSelectionConsumedAt: requests.pageSelectionConsumedAt,
};
type AuthorizationRequest = typeof requests.$inferSelect;
export type ConsumedMetaAuthorization = Pick<AuthorizationRequest, keyof typeof STATE_COLUMNS>;
type Phase = "discovery" | "selection" | "finish";
const connectionShape = z.strictObject({
  credentials: z.record(z.string(), z.string()),
  account: z.string().trim().min(1).max(300),
  target: z.string().min(1).max(2048),
  applicationId: z.string().regex(/^[1-9]\d{0,30}$/),
});
const pageChoicesSchema = z.array(connectionShape).min(1).max(META_MAX_DISCOVERED_PAGES);

/** An internal proven bag still must satisfy the exact adapter destination contract. */
export function validateMetaConnection(
  runtime: MetaRuntimeConfiguration,
  connection: MetaAccountConnection,
): MetaAccountConnection {
  try {
    const value = connectionShape.parse(connection);
    const credentials =
      runtime.provider === "facebook_page"
        ? facebookPageCredentialsSchema.parse(value.credentials)
        : runtime.provider === "instagram_native"
          ? instagramNativeCredentialsSchema.parse(value.credentials)
          : threadsCredentialsSchema.parse(value.credentials);
    const target =
      runtime.provider === "facebook_page"
        ? facebookPageCredentialTarget(facebookPageCredentialsSchema.parse(credentials))
        : runtime.provider === "instagram_native"
          ? instagramCredentialTarget(instagramNativeCredentialsSchema.parse(credentials))
          : threadsCredentialTarget(threadsCredentialsSchema.parse(credentials));
    if (
      value.applicationId !== runtime.application.clientId ||
      value.target !== target ||
      !z.string().min(1).max(2048).safeParse(credentials.scopes).success ||
      !z.iso.datetime({ offset: true }).safeParse(credentials.expiresAt).success ||
      [
        value.credentials.accessToken,
        value.credentials.userAccessToken,
        value.credentials.refreshToken,
        runtime.application.clientSecret,
      ].some((secret) => secret && value.account.includes(secret))
    )
      throw new Error("invalid connection proof");
    return value;
  } catch {
    throw badRequest(
      "meta_authorization_failed",
      "Meta did not confirm the selected account and token lifecycle",
    );
  }
}

function stateHash(value: string) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value))
    throw conflict("meta_authorization_invalid", "Start a new Meta connection request");
  return createHash("sha256").update(value).digest("hex");
}
function actorFor(orgId: string) {
  const actor = currentRequestAuthority();
  if (actor?.kind !== "session" || actor.orgId !== orgId)
    throw forbidden("meta_authority_changed", "A current manager session is required");
  return actor;
}
function sameIntent(before: ConsumedMetaAuthorization, after: ConsumedMetaAuthorization) {
  return (
    JSON.stringify([
      before.id,
      before.orgId,
      before.brandId,
      before.provider,
      before.applicationId,
      before.redirectUri,
      before.userId,
      before.sessionId,
      before.channelId,
      before.expectedGeneration,
      before.expectedTarget,
      before.name,
      before.locale,
      before.createdAt.toISOString(),
      before.expiresAt.toISOString(),
    ]) ===
    JSON.stringify([
      after.id,
      after.orgId,
      after.brandId,
      after.provider,
      after.applicationId,
      after.redirectUri,
      after.userId,
      after.sessionId,
      after.channelId,
      after.expectedGeneration,
      after.expectedTarget,
      after.name,
      after.locale,
      after.createdAt.toISOString(),
      after.expiresAt.toISOString(),
    ])
  );
}

@Injectable()
export class MetaConnectionsRepository {
  private async admission(tx: Tx, orgId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
    );
    await holdOrganization(tx, orgId);
  }
  private async authorize(tx: Tx, orgId: string, brandId: string) {
    const actor = actorFor(orgId);
    if (actor.brandId !== undefined && actor.brandId !== brandId)
      throw forbidden("meta_authority_changed", "The authorized brand changed");
    if (!(await authorizeRequestActor(tx, orgId)))
      throw forbidden("meta_authority_changed", "Session or organization access changed");
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
      throw forbidden("meta_authority_changed", "Organization owner or admin required");
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
    if (!session) throw forbidden("meta_authority_changed", "The session expired; start again");
  }
  private async clock(tx: Tx) {
    const result = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    if (!result.rows[0]) throw new Error("Meta connection clock could not be read");
    return new Date(result.rows[0].now);
  }
  private async channel(
    tx: Tx,
    orgId: string,
    brandId: string,
    id: string,
    generation: number,
    provider: MetaConnectionProvider,
  ) {
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
    if (!channel || channel.platform !== provider)
      throw notFound("channel_not_found", "Meta channel not found");
    if (channel.generation !== generation || channel.generation >= 2_147_483_647)
      throw conflict(
        "meta_connection_changed",
        "The connection changed; reload before reconnecting",
      );
    return channel;
  }
  private phaseCondition(provider: MetaConnectionProvider, phase: Phase) {
    if (phase === "selection")
      return and(
        isNotNull(requests.pageSelectionEncrypted),
        isNull(requests.pageSelectionConsumedAt),
      );
    if (phase === "finish" && provider === "facebook_page")
      return and(
        isNull(requests.pageSelectionEncrypted),
        isNotNull(requests.pageSelectionConsumedAt),
      );
    return and(isNull(requests.pageSelectionEncrypted), isNull(requests.pageSelectionConsumedAt));
  }
  /** Re-read immutable persisted intent, retaining channel-before-state lock order for cascades. */
  private async state(
    tx: Tx,
    orgId: string,
    id: string,
    runtime: MetaRuntimeConfiguration,
    phase: Phase,
  ) {
    const actor = actorFor(orgId);
    const condition = and(
      eq(requests.orgId, orgId),
      eq(requests.id, id),
      eq(requests.provider, runtime.provider),
      eq(requests.applicationId, runtime.application.clientId),
      eq(requests.redirectUri, runtime.redirectUri),
      eq(requests.userId, actor.userId),
      eq(requests.sessionId, actor.sessionId),
      isNotNull(requests.consumedAt),
      sql`${requests.expiresAt} > clock_timestamp()`,
      this.phaseCondition(runtime.provider, phase),
    );
    const [snapshot] = await tx.select(STATE_COLUMNS).from(requests).where(condition);
    if (!snapshot)
      throw conflict(
        "meta_authorization_invalid",
        "This connection request expired, changed or was already used",
      );
    await this.authorize(tx, orgId, snapshot.brandId);
    const channel =
      snapshot.channelId !== null && snapshot.expectedGeneration !== null
        ? await this.channel(
            tx,
            orgId,
            snapshot.brandId,
            snapshot.channelId,
            snapshot.expectedGeneration,
            runtime.provider,
          )
        : null;
    if (channel && channel.target !== snapshot.expectedTarget)
      throw conflict("channel_target_changed", "The channel destination changed");
    const [state] = await tx.select(STATE_COLUMNS).from(requests).where(condition).for("update");
    if (!state || !sameIntent(snapshot, state))
      throw conflict("meta_authorization_invalid", "Start a new Meta connection request");
    await this.currentSession(tx, orgId);
    if (state.expiresAt <= (await this.clock(tx)))
      throw conflict("meta_authorization_invalid", "The connection request expired; start again");
    return { state, channel };
  }

  async start(
    orgId: string,
    intent: MetaAuthorizationStart,
    authorization: { state: string },
    runtime: MetaRuntimeConfiguration,
  ) {
    if (runtime.provider !== intent.provider)
      throw conflict("meta_authorization_invalid", "The connection provider changed");
    const hash = stateHash(authorization.state);
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
              intent.provider,
            )
          : null;
      await tx
        .delete(requests)
        .where(and(eq(requests.orgId, orgId), sql`${requests.expiresAt} <= clock_timestamp()`));
      const [capacity] = await tx
        .select({ count: sql<number>`count(*)::integer`.mapWith(Number) })
        .from(requests)
        .where(eq(requests.orgId, orgId));
      if ((capacity?.count ?? META_MAX_AUTHORIZATION_REQUESTS) >= META_MAX_AUTHORIZATION_REQUESTS)
        throw conflict(
          "meta_authorization_capacity",
          "Wait for earlier connection requests to expire before starting again",
        );
      await this.currentSession(tx, orgId);
      const createdAt = await this.clock(tx);
      await tx.insert(requests).values({
        orgId,
        brandId: intent.brandId,
        provider: intent.provider,
        applicationId: runtime.application.clientId,
        redirectUri: runtime.redirectUri,
        userId: actor.userId,
        sessionId: actor.sessionId,
        stateHash: hash,
        channelId: channel?.id ?? null,
        expectedGeneration: channel?.generation ?? null,
        expectedTarget: channel?.target ?? null,
        name: intent.name,
        locale: intent.locale,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + META_AUTHORIZATION_TTL_SECONDS * 1000),
      });
    });
  }

  /** Commit one-use state consumption before any provider exchange. */
  async consume(
    orgId: string,
    provider: MetaConnectionProvider,
    state: string,
    runtime: MetaRuntimeConfiguration,
  ): Promise<ConsumedMetaAuthorization> {
    const hash = stateHash(state);
    return db.transaction(async (tx) => {
      await this.admission(tx, orgId);
      const actor = actorFor(orgId);
      const condition = and(
        eq(requests.orgId, orgId),
        eq(requests.provider, provider),
        eq(requests.provider, runtime.provider),
        eq(requests.stateHash, hash),
        eq(requests.applicationId, runtime.application.clientId),
        eq(requests.redirectUri, runtime.redirectUri),
        eq(requests.userId, actor.userId),
        eq(requests.sessionId, actor.sessionId),
        isNull(requests.consumedAt),
        sql`${requests.expiresAt} > clock_timestamp()`,
      );
      const [snapshot] = await tx.select(STATE_COLUMNS).from(requests).where(condition);
      if (!snapshot)
        throw conflict(
          "meta_authorization_invalid",
          "This authorization request expired, changed or was already used",
        );
      await this.authorize(tx, orgId, snapshot.brandId);
      if (snapshot.channelId !== null && snapshot.expectedGeneration !== null) {
        const channel = await this.channel(
          tx,
          orgId,
          snapshot.brandId,
          snapshot.channelId,
          snapshot.expectedGeneration,
          provider,
        );
        if (channel.target !== snapshot.expectedTarget)
          throw conflict("channel_target_changed", "The channel destination changed");
      }
      await this.currentSession(tx, orgId);
      const [consumed] = await tx
        .update(requests)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(and(condition, eq(requests.id, snapshot.id)))
        .returning(STATE_COLUMNS);
      if (!consumed || !sameIntent(snapshot, consumed))
        throw conflict("meta_authorization_invalid", "Start a new Meta connection request");
      // UPDATE may have waited after qualifying the row. Consume only while both
      // the authorization request and its initiating session are still current.
      await this.currentSession(tx, orgId);
      if (consumed.expiresAt <= (await this.clock(tx)))
        throw conflict("meta_authorization_invalid", "The connection request expired; start again");
      return consumed;
    });
  }

  async stagePages(
    orgId: string,
    requestId: string,
    runtime: MetaRuntimeConfiguration,
    discovery: MetaPageDiscovery,
  ) {
    if (runtime.provider !== "facebook_page")
      throw badRequest("meta_authorization_failed", "Only Facebook connections can choose a Page");
    const pages = pageChoicesSchema.safeParse(discovery.pages);
    if (!pages.success || new Set(pages.data.map((page) => page.target)).size !== pages.data.length)
      throw badRequest(
        "meta_authorization_failed",
        "Meta did not return an unambiguous bounded Page choice",
      );
    return db.transaction(async (tx) => {
      await this.admission(tx, orgId);
      const { state } = await this.state(tx, orgId, requestId, runtime, "discovery");
      const choices = pages.data.map((page) => validateMetaConnection(runtime, page));
      const encrypted = encryptJson({ pages: choices }, env.APP_ENCRYPTION_KEY);
      const now = await this.clock(tx);
      if (state.expiresAt <= now)
        throw conflict("meta_authorization_invalid", "The connection request expired; start again");
      if (choices.some((choice) => new Date(choice.credentials.expiresAt as string) <= now))
        throw conflict("meta_reconnect_required", "The account token expired; start again");
      await this.currentSession(tx, orgId);
      await tx
        .update(requests)
        .set({ pageSelectionEncrypted: encrypted })
        .where(and(eq(requests.orgId, orgId), eq(requests.id, state.id)));
      return metaAuthorizationCompletedSchema.parse({
        status: "choose_page",
        requestId: state.id,
        brandId: state.brandId,
        locale: state.locale,
        expiresAt: state.expiresAt.toISOString(),
        pages: choices.map((choice) => ({ id: choice.credentials.pageId, name: choice.account })),
      });
    });
  }

  /** Burn the encrypted choice before its new provider verification; failure requires restart. */
  async consumePage(
    orgId: string,
    requestId: string,
    pageId: string,
    runtime: MetaRuntimeConfiguration,
  ) {
    if (runtime.provider !== "facebook_page")
      throw conflict("meta_authorization_invalid", "Start a new Facebook Page connection request");
    return db.transaction(async (tx) => {
      await this.admission(tx, orgId);
      const { state } = await this.state(tx, orgId, requestId, runtime, "selection");
      let choices: MetaAccountConnection[];
      try {
        const plaintext: unknown = decryptJson(
          state.pageSelectionEncrypted as string,
          env.APP_ENCRYPTION_KEY,
        );
        choices = z
          .strictObject({ pages: pageChoicesSchema })
          .parse(plaintext)
          .pages.map((page) => validateMetaConnection(runtime, page));
      } catch {
        throw conflict(
          "meta_authorization_invalid",
          "The saved Page choices could not be verified; start again",
        );
      }
      const matching = choices.filter((choice) => choice.credentials.pageId === pageId);
      if (matching.length !== 1)
        throw conflict(
          "meta_authorization_invalid",
          "Choose exactly one Page from this connection request",
        );
      const connection = matching[0];
      if (!connection) throw conflict("meta_authorization_invalid", "Choose a Page again");
      await this.currentSession(tx, orgId);
      if (state.expiresAt <= (await this.clock(tx)))
        throw conflict("meta_authorization_invalid", "The connection request expired; start again");
      await tx
        .update(requests)
        .set({ pageSelectionEncrypted: null, pageSelectionConsumedAt: sql`clock_timestamp()` })
        .where(and(eq(requests.orgId, orgId), eq(requests.id, state.id)));
      return {
        requestId: state.id,
        connection,
        secrets: choices.flatMap((choice) =>
          [
            choice.credentials.accessToken,
            choice.credentials.userAccessToken,
            choice.credentials.refreshToken,
          ].filter((secret): secret is string => typeof secret === "string"),
        ),
      };
    });
  }

  async finish(
    orgId: string,
    requestId: string,
    runtime: MetaRuntimeConfiguration,
    proof: MetaAccountConnection,
  ) {
    return withQuotaErrors(() =>
      db.transaction(async (tx) => {
        await this.admission(tx, orgId);
        const { state, channel } = await this.state(tx, orgId, requestId, runtime, "finish");
        const connection = validateMetaConnection(runtime, proof);
        if (
          channel &&
          (channel.target !== state.expectedTarget || channel.target !== connection.target)
        )
          throw conflict(
            "channel_target_changed",
            "Reconnect the same account; another destination needs a new channel",
          );
        const write = async (targetTx: Tx) => {
          // Quota/billing locks can consume both state and token lifetime. Use the database clock after waiting.
          await this.currentSession(targetTx, orgId);
          const now = await this.clock(targetTx);
          const expiresAt = new Date(connection.credentials.expiresAt as string);
          if (state.expiresAt <= now)
            throw conflict(
              "meta_authorization_invalid",
              "The connection request expired; start again",
            );
          if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)
            throw conflict("meta_reconnect_required", "The account token expired; reconnect");
          const values = {
            credentialsEncrypted: encryptJson(connection.credentials, env.APP_ENCRYPTION_KEY),
            connectionApplicationId: runtime.application.clientId,
            connectionAccount: connection.account,
            connectionScopes: connection.credentials.scopes,
            connectionExpiresAt: expiresAt,
            connectionConnectedAt: now,
            connectionDisconnectedAt: null,
            healthOk: true,
            healthCheckedAt: now,
          };
          const [saved] = channel
            ? await targetTx
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
                .returning({ id: schema.channels.id })
            : await targetTx
                .insert(schema.channels)
                .values({
                  ...values,
                  orgId,
                  brandId: state.brandId,
                  platform: state.provider,
                  name: state.name,
                  connectionTarget: connection.target,
                  connectionGeneration: 1,
                })
                .returning({ id: schema.channels.id });
          if (!saved)
            throw conflict("meta_connection_changed", "The connection changed; reload it");
          await targetTx
            .delete(requests)
            .where(and(eq(requests.orgId, orgId), eq(requests.id, state.id)));
          return metaAuthorizationCompletedSchema.parse({
            status: "connected",
            brandId: state.brandId,
            channelId: saved.id,
            locale: state.locale,
          });
        };
        return channel
          ? write(tx)
          : withTenantResourceAdmissionWithHeldLocks(
              orgId,
              tx,
              { ...tenantQuotaMode(), authorizeActor: authorizeRequestActor },
              { resource: "channels", additional: 1 },
              write,
            );
      }),
    );
  }

  async disconnect(orgId: string, id: string, expectedGeneration: number): Promise<void> {
    const [snapshot] = await db
      .select({ brandId: schema.channels.brandId, platform: schema.channels.platform })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)));
    if (!snapshot || !["threads", "instagram_native", "facebook_page"].includes(snapshot.platform))
      throw notFound("channel_not_found", "Meta channel not found");
    await db.transaction(async (tx) => {
      await this.admission(tx, orgId);
      await this.authorize(tx, orgId, snapshot.brandId);
      const channel = await this.channel(
        tx,
        orgId,
        snapshot.brandId,
        id,
        expectedGeneration,
        snapshot.platform as MetaConnectionProvider,
      );
      await this.currentSession(tx, orgId);
      await tx
        .update(schema.channels)
        .set({
          credentialsEncrypted: null,
          connectionGeneration: sql`${schema.channels.connectionGeneration} + 1`,
          connectionDisconnectedAt: await this.clock(tx),
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
      // Publication jobs, adaptation state, immutable destination and retained receipts stay intact.
    });
  }
}
