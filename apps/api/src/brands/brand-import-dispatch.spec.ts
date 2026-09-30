import { HttpException } from "@nestjs/common";
import { ProviderPreflightError } from "@pubrick/ai";
import { AiCallAdmissionError } from "@pubrick/db";
import { guardedFetchText } from "guarded-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { hostedAiCallScope } from "../hosted-ai-call";
import { BrandImportCaller } from "./brand-import.caller";
import { BrandImportService } from "./brand-import.service";
import type { BrandsRepository } from "./brands.repository";

const mocks = vi.hoisted(() => ({
  sequence: [] as string[],
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  txCount: 0,
}));
vi.mock("../db", () => {
  const select = (inTx = false) => {
    const result = [{ count: inTx ? mocks.txCount : 0, id: "org_brand" }];
    const chain = {
      from: () => chain,
      where: () => chain,
      for: async () => result,
      // biome-ignore lint/suspicious/noThenProperty: Drizzle select builders are intentionally awaitable.
      then: (resolve: (rows: typeof result) => unknown) => Promise.resolve(resolve(result)),
    };
    return chain;
  };
  const tx = {
    select: () => select(true),
    insert: () => ({
      values: (values: unknown) => {
        mocks.insert(values);
        mocks.sequence.push("reserve");
        return { returning: async () => [{ id: "reservation" }] };
      },
    }),
  };
  return {
    db: {
      select: () => select(),
      transaction: async (execute: (tx: unknown) => Promise<unknown>) => {
        mocks.transaction();
        return execute(tx);
      },
      update: () => ({
        set: (record: unknown) => {
          mocks.update(record);
          mocks.sequence.push("meter");
          return { where: () => ({ returning: async () => [{ id: "reservation" }] }) };
        },
      }),
    },
  };
});
vi.mock("../env", () => ({ env: {} }));
vi.mock("../ai-credentials/ai-credentials.repository", () => ({
  AiCredentialsRepository: class {},
}));
vi.mock("./brands.repository", () => ({
  BrandsRepository: class {},
  brandImportProfileHash: () => "hash",
}));
vi.mock("../hosted-ai-call", async (original) => ({
  ...(await original<typeof import("../hosted-ai-call")>()),
  hostedAiCallScope: vi.fn(),
}));
vi.mock("guarded-fetch", async (original) => ({
  ...(await original<typeof import("guarded-fetch")>()),
  guardedFetchText: vi.fn(),
}));
const suggestion = {
  name: "Coffee",
  description: "Useful coffee",
  voice: "Clear",
  audience: "Owners",
  contentLanguage: "en",
  topics: ["Roast"],
};
function fixture() {
  const brands = { get: vi.fn().mockResolvedValue({ id: "brand", name: "Coffee" }) };
  const credentials = {
    getDecrypted: vi.fn().mockResolvedValue({
      provider: "google",
      apiKey: "fixture",
      defaultModel: "gemini-3.8-flash",
    }),
  };
  const fetch = vi.fn(async () => {
    mocks.sequence.push("http");
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts: [{ text: JSON.stringify(suggestion) }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    service: new BrandImportService(
      brands as unknown as BrandsRepository,
      credentials as unknown as AiCredentialsRepository,
      new BrandImportCaller(),
    ),
  };
}
const request = { url: "https://example.com", acceptAiCost: true as const };
beforeEach(() => {
  mocks.sequence.length = 0;
  mocks.txCount = 0;
  vi.mocked(guardedFetchText).mockResolvedValue(
    `<p>${"Useful coffee details for cafe owners. ".repeat(10)}</p>`,
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("brand import physical admission and reservation", () => {
  it("refuses local capacity without HTTP or a phantom unknown-spend reservation", async () => {
    const { service, fetch } = fixture();
    const refusal = new ProviderPreflightError("Subscription expired");
    refusal.cause = new AiCallAdmissionError("subscription_required");
    vi.mocked(hostedAiCallScope).mockReturnValueOnce(async () => {
      throw refusal;
    });
    await expect(service.preview("org_brand", "brand", request)).rejects.toMatchObject({
      status: 402,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("reserves only after physical admission and meters the actual response", async () => {
    const { service, fetch } = fixture();
    vi.mocked(hostedAiCallScope).mockReturnValueOnce(async (execute) => {
      mocks.sequence.push("acquire");
      try {
        return await execute(new AbortController().signal);
      } finally {
        mocks.sequence.push("release");
      }
    });
    await expect(service.preview("org_brand", "brand", request)).resolves.toMatchObject({
      suggestion,
    });
    expect(mocks.sequence).toEqual(["acquire", "reserve", "http", "release", "meter"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", outcome: "completed" }),
    );
  });
  it("keeps a late hourly cap refusal before provider HTTP or unknown spend", async () => {
    const { service, fetch } = fixture();
    mocks.txCount = 3;
    vi.mocked(hostedAiCallScope).mockReturnValueOnce(async (execute) =>
      execute(new AbortController().signal),
    );
    await expect(service.preview("org_brand", "brand", request)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("retains the existing self-hosted reservation and metering flow", async () => {
    const { service } = fixture();
    vi.mocked(hostedAiCallScope).mockReturnValueOnce(undefined);
    await service.preview("org_brand", "brand", request);
    expect(mocks.sequence).toEqual(["reserve", "http", "meter"]);
  });
});
