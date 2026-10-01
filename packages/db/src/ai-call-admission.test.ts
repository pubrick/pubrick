import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireHostedAiCall,
  aiCallDispatchBudget,
  withHostedAiCall,
} from "./ai-call-admission.js";
import type { createDb } from "./client.js";

type Database = ReturnType<typeof createDb>["db"];
const selfHosted = { mode: "self-hosted" } as const;
function unusedDb() {
  return {
    transaction: vi.fn(() => {
      throw new Error("DB should not run");
    }),
  } as unknown as Database;
}
afterEach(() => vi.restoreAllMocks());
describe("physical call scope contracts", () => {
  it("fixed budgets cannot be configured to unbounded durations", () => {
    expect(
      ["text", "image", "embedding", "probe"].map((kind) => aiCallDispatchBudget(kind as "text")),
    ).toEqual([120000, 120000, 30000, 30000]);
    expect(() => aiCallDispatchBudget("other" as "text")).toThrow("admission_unavailable");
  });
  it("already aborted performs neither SQL nor dispatch", async () => {
    const db = unusedDb();
    const dispatch = vi.fn();
    await expect(
      withHostedAiCall("org", db, selfHosted, "text", AbortSignal.abort(), dispatch),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("self-hosted admission performs no billing or lease transaction", async () => {
    const db = unusedDb();
    await expect(acquireHostedAiCall("org", db, selfHosted, "text")).resolves.toBeNull();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it("forwards combined cancellation and awaits actual unsettled callback", async () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let scopeSignal: AbortSignal | undefined;
    const result = withHostedAiCall(
      "org",
      unusedDb(),
      selfHosted,
      "image",
      caller.signal,
      async (scope) => {
        scopeSignal = scope.signal;
        await settled;
        return "actual result";
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(timeout).toHaveBeenCalledWith(120000);
    expect(scopeSignal?.aborted).toBe(false);
    caller.abort();
    expect(scopeSignal?.aborted).toBe(true);
    let completed = false;
    result.finally(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await expect(result).resolves.toBe("actual result");
  });
  it("timeout before admission continuation prevents dispatch", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const dispatch = vi.fn();
    await expect(
      withHostedAiCall("org", unusedDb(), selfHosted, "embedding", undefined, dispatch),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("keeps SDK failure identity for existing retry policy", async () => {
    const error = new Error("SDK failure");
    await expect(
      withHostedAiCall("org", unusedDb(), selfHosted, "probe", undefined, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
  it("sanitizes SQL failure before physical dispatch", async () => {
    const db = {
      transaction: vi.fn().mockRejectedValue(new Error("password=secret SQL server")),
    } as unknown as Database;
    const dispatch = vi.fn();
    await expect(
      withHostedAiCall(
        "org",
        db,
        {
          mode: "hosted",
          identity: { provider: "stripe", environment: "sandbox", accountId: "acct" },
        },
        "text",
        undefined,
        dispatch,
      ),
    ).rejects.toMatchObject({ message: "admission_unavailable", code: "admission_unavailable" });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it("self-hosted trusted authority refuses before physical dispatch without a billing lease", async () => {
  const tx = {
    execute: vi.fn(async () => {}),
    select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: "org" }] }) }) }),
  };
  const db = {
    transaction: async <T>(action: (tx: unknown) => Promise<T>) => action(tx),
  } as unknown as Database;
  const dispatch = vi.fn(),
    authorizeActor = vi.fn(async () => false);
  await expect(
    withHostedAiCall(
      "org",
      db,
      { mode: "self-hosted", authorizeActor },
      "text",
      undefined,
      dispatch,
    ),
  ).rejects.toMatchObject({ code: "authority_revoked" });
  expect(authorizeActor).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
});
