import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { hostedIdentityPlugin, isRawOrganizationMutation } from "./auth-hosted.plugin";

const denied = [
  "create",
  "invite-member",
  "accept-invitation",
  "reject-invitation",
  "cancel-invitation",
  "remove-member",
  "update-member-role",
  "leave",
  "delete",
  "add-member",
  "create-team",
  "add-team-member",
  "create-role",
  "unknown-new-writer",
];
describe("hosted raw organization mutation boundary", () => {
  it("closes every growth, cancellation and membership writer while preserving safe SDK operations", () => {
    for (const path of denied)
      expect(isRawOrganizationMutation(`/organization/${path}`)).toBe(true);
    for (const path of [
      "list",
      "get-full-organization",
      "list-members",
      "get-active-member",
      "get-active-member-role",
      "get-invitation",
      "list-invitations",
      "list-user-invitations",
      "set-active",
      "check-slug",
      "update",
    ])
      expect(isRawOrganizationMutation(`/organization/${path}`)).toBe(false);
    expect(isRawOrganizationMutation(undefined, "addOrganizationMember")).toBe(true);
    expect(isRawOrganizationMutation("/get-session")).toBe(false);
  });
  it("uses real Better Auth dispatch to refuse the pathless server-only addMember", async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:31399",
      secret: "isolated-runtime-secret-12345",
      database: memoryAdapter({}),
      logger: { disabled: true },
      plugins: [
        hostedIdentityPlugin(true, true, { enabled: true, testMode: true }),
        organization(),
      ],
    });
    await expect(
      auth.api.addMember({
        body: { userId: "recipient", organizationId: "workspace", role: "member" },
      }),
    ).rejects.toMatchObject({ body: { code: "HOSTED_ORGANIZATION_MUTATION_REQUIRED" } });
  });
  it("returns the closed refusal through the real HTTP hook pipeline", async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:31398",
      secret: "isolated-runtime-secret-12345",
      database: memoryAdapter({}),
      logger: { disabled: true },
      plugins: [
        hostedIdentityPlugin(true, true, { enabled: true, testMode: true }),
        organization(),
      ],
    });
    for (const path of [
      "create",
      "invite-member",
      "accept-invitation",
      "cancel-invitation",
      "update-member-role",
      "leave",
      "delete",
    ]) {
      const result = await auth.handler(
        new Request(`http://localhost:31398/api/auth/organization/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:31398" },
          body: JSON.stringify({
            name: "Untrusted",
            slug: "untrusted",
            organizationId: "workspace",
            email: "user@example.test",
            role: "member",
            invitationId: "invite",
            memberId: "member",
          }),
        }),
      );
      expect(result.status).toBe(403);
      expect(await result.json()).toMatchObject({ code: "HOSTED_ORGANIZATION_MUTATION_REQUIRED" });
    }
  });
  it("publishes minimal sandbox capability booleans without payment secrets or catalog", async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:31397",
      secret: "isolated-runtime-secret-12345",
      database: memoryAdapter({}),
      logger: { disabled: true },
      plugins: [hostedIdentityPlugin(true, true, { enabled: true, testMode: true })],
    });
    const result = await auth.handler(
      new Request("http://localhost:31397/api/auth/pubrick-capabilities"),
    );
    expect(await result.json()).toEqual({
      requiresEmailVerification: true,
      passwordRecoveryEnabled: true,
      deploymentMode: "hosted",
      billingEnabled: true,
      billingTestMode: true,
    });
  });
  it("self-hosted and isolated identity-only components do not activate billing denial", () => {
    const request = { path: "/organization/create" };
    const selfHosted = hostedIdentityPlugin(false, false, { enabled: false, testMode: false });
    const identityOnly = hostedIdentityPlugin(true, true);
    expect(
      selfHosted.hooks?.before?.[1]?.matcher(
        request as Parameters<
          NonNullable<NonNullable<typeof selfHosted.hooks>["before"]>[number]["matcher"]
        >[0],
      ),
    ).toBe(false);
    expect(
      identityOnly.hooks?.before?.[1]?.matcher(
        request as Parameters<
          NonNullable<NonNullable<typeof identityOnly.hooks>["before"]>[number]["matcher"]
        >[0],
      ),
    ).toBe(false);
  });
});
