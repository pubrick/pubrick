import { adaptationLimit, PROMPT_ROLES } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { builtInRoleTemplateSource } from "./role-template.js";
import {
  digest,
  InvalidTemplateSnapshotError,
  receiptDigest,
  type TemplateSnapshot,
  validateTemplateSnapshot,
} from "./template-snapshot.js";

const channelId = "918d67ec-adfe-44a3-91dc-2dce913093ee";

function validSnapshot(): TemplateSnapshot {
  const roles = Object.fromEntries(
    PROMPT_ROLES.map((role) => {
      const source = builtInRoleTemplateSource(role);
      return [
        role,
        { kind: "default", revisionId: null, version: null, source, sourceSha256: digest(source) },
      ];
    }),
  ) as TemplateSnapshot["roles"];
  const telegramLimit = adaptationLimit("telegram");
  if (telegramLimit === undefined) throw new Error("Telegram limit is missing");
  const receipt: TemplateSnapshot["receipt"] = {
    contentType: "social_post",
    claimDateUtc: "2026-09-25",
    brand: { name: "Example", voice: null, audience: null, contentLanguage: "en" },
    channels: [
      { id: channelId, name: "Example Telegram", platform: "telegram", limit: telegramLimit },
    ],
  };
  const pinned = { text: "Pinned instruction", sha256: digest("Pinned instruction") };
  return {
    formatVersion: 1,
    engineVersion: "role-template-v1",
    roles,
    receipt,
    receiptSha256: receiptDigest(receipt),
    instructions: {
      researcher: pinned,
      writer: pinned,
      editor: pinned,
      factcheck: pinned,
      adapters: { [channelId]: pinned },
    },
  };
}

describe("persisted role template snapshot", () => {
  it("accepts a complete pinned default snapshot", () => {
    const snapshot = validSnapshot();
    expect(validateTemplateSnapshot(snapshot)).toEqual(snapshot);
  });

  it.each([
    [
      "missing role",
      (snapshot: TemplateSnapshot) => delete (snapshot.roles as Record<string, unknown>).editor,
    ],
    [
      "invented default",
      (snapshot: TemplateSnapshot) => {
        snapshot.roles.writer.source = "Invented";
        snapshot.roles.writer.sourceSha256 = digest("Invented");
      },
    ],
    [
      "changed receipt",
      (snapshot: TemplateSnapshot) => {
        snapshot.receipt.brand.name = "Changed";
      },
    ],
    [
      "missing adapter",
      (snapshot: TemplateSnapshot) => {
        delete snapshot.instructions.adapters[channelId];
      },
    ],
    [
      "changed instruction",
      (snapshot: TemplateSnapshot) => {
        snapshot.instructions.writer.text = "Changed";
      },
    ],
  ])("rejects %s before attribution or a model call", (_case, corrupt) => {
    const snapshot = structuredClone(validSnapshot());
    corrupt(snapshot);
    expect(() => validateTemplateSnapshot(snapshot)).toThrow(InvalidTemplateSnapshotError);
  });
});
