import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as tables from "./schema/telegram-draft-decisions.js";

const configs = Object.values(tables as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => ({ table, config: getTableConfig(table) }));
describe("Telegram foundation storage inventory", () => {
  it("keeps all nine foundation tables and every expiration instant zoned", () => {
    expect(configs.map(({ config }) => config.name).sort()).toEqual([
      "telegram_actor_confirmations",
      "telegram_binding_challenges",
      "telegram_bindings",
      "telegram_bot_identities",
      "telegram_decision_audit",
      "telegram_decision_configs",
      "telegram_initial_capabilities",
      "telegram_remote_attempts",
      "telegram_update_receipts",
    ]);
    const instants = configs
      .flatMap(({ table }) => Object.values(getTableColumns(table)))
      .filter((column) => column.getSQLType().startsWith("timestamp"));
    expect(instants.length).toBeGreaterThan(20);
    expect(instants.every((column) => column.getSQLType() === "timestamp with time zone")).toBe(
      true,
    );
  });
  it("gives actor-owned rows direct user and org cascades with no nested capability/resource cascade", () => {
    for (const name of [
      "telegram_binding_challenges",
      "telegram_bindings",
      "telegram_actor_confirmations",
    ]) {
      const config = configs.find((entry) => entry.config.name === name)?.config;
      expect(config).toBeDefined();
      expect(
        config?.foreignKeys
          .map((fk) => ({
            parent: getTableConfig(fk.reference().foreignTable).name,
            deletion: fk.onDelete,
          }))
          .sort((a, b) => a.parent.localeCompare(b.parent)),
      ).toEqual([
        { parent: "organization", deletion: "cascade" },
        { parent: "user", deletion: "cascade" },
      ]);
    }
    for (const name of [
      "telegram_initial_capabilities",
      "telegram_update_receipts",
      "telegram_decision_audit",
    ]) {
      const config = configs.find((entry) => entry.config.name === name)?.config;
      expect(
        config?.foreignKeys.map((fk) => ({
          parent: getTableConfig(fk.reference().foreignTable).name,
          deletion: fk.onDelete,
        })),
      ).toEqual([{ parent: "organization", deletion: "cascade" }]);
    }
  });
  it("keeps provider human identity and secrets out of global lane and minimal evidence", () => {
    for (const table of [
      tables.telegramBotIdentities,
      tables.telegramRemoteAttempts,
      tables.telegramUpdateReceipts,
      tables.telegramDecisionAudit,
    ]) {
      const names = Object.values(getTableColumns(table)).map((column) => column.name);
      expect(
        names.filter((name) =>
          /telegram_user|chat|display_name|secret|credentials|token|payload/.test(name),
        ),
      ).toEqual([]);
    }
    expect(tables.telegramDecisionAudit.actorUserId.getSQLType()).toBe("text");
    expect(tables.telegramBotIdentities.ownerOrgId.notNull).toBe(false);
    expect(getTableConfig(tables.telegramBotIdentities).foreignKeys[0]?.onDelete).toBe("set null");
    expect(
      Object.values(getTableColumns(tables.telegramRemoteAttempts)).some((column) =>
        /expires|lease/.test(column.name),
      ),
    ).toBe(false);
  });
});
