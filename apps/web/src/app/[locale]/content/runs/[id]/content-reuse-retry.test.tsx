import { contentReuseRetrySchema, runDetailDtoSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInOrganization, signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import { ContentReuseRetryAction } from "./content-reuse-retry";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

import { ApiError, api } from "@/lib/api";

const mockApi = vi.mocked(api);
const RUN = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const RESULT = "44444444-4444-4444-8444-444444444444";
function makeRun() {
  return runDetailDtoSchema.parse({
    id: RUN,
    brandId: SOURCE,
    input: {
      kind: "source",
      sourceUrl: null,
      material: "Frozen saved master",
      text: "Frozen instructions",
      channelIds: [CHANNEL],
      contentType: "social_post",
    },
    internalSource: {
      state: "available",
      sourceContentId: SOURCE,
      sourceRevision: 7,
      title: "Saved title",
      origin: "external",
    },
    status: "failed",
    currentStep: null,
    contentItemId: null,
    errorCode: "provider_unavailable",
    dismissedAt: null,
    unrecordedCalls: 0,
    steps: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
}
const posts = () => mockApi.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  signedInSession();
  signedInOrganization();
  mockApi.mockReset();
  mockApi.mockImplementation(async (_path, init) =>
    init?.method === "POST"
      ? { id: RESULT, status: "queued" }
      : [{ id: CHANNEL, name: "Manual", platform: "vc_ru" }],
  );
});
describe("saved source paid retry", () => {
  it("opening and cancelling only read channels; confirmation submits the strict consent-only DTO", async () => {
    render(<ContentReuseRetryAction run={makeRun()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Reuse.retry }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Frozen saved master")).toBeInTheDocument();
    expect(within(dialog).getByText("Frozen instructions")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: en.Reuse.generate })).toBeDisabled();
    expect(posts()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: en.Reuse.cancel }));
    expect(posts()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: en.Reuse.retry }));
    await user.click(screen.getByRole("checkbox", { name: en.Reuse.consent }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Reuse.generate }),
    );
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${RESULT}`));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.[0]).toBe(`/api/runs/${RUN}/retry`);
    expect(contentReuseRetrySchema.parse(JSON.parse(posts()[0]?.[1]?.body as string))).toEqual({
      allowPaidGeneration: true,
      consentVersion: "byok-paid-generation-v1",
    });
  });
  it("a lost acknowledgement retains the confirmed snapshot and key even after source redaction", async () => {
    const run = makeRun();
    const view = render(<ContentReuseRetryAction run={run} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Reuse.retry }));
    await screen.findByRole("dialog");
    mockApi.mockRejectedValueOnce(new ApiError(0, "Synthetic lost response"));
    await user.click(screen.getByRole("checkbox", { name: en.Reuse.consent }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Reuse.generate }),
    );
    await screen.findAllByText(en.Reuse.uncertain);
    mockApi.mockRejectedValueOnce(
      new ApiError(403, "Synthetic authority refusal", false, "forbidden"),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Reuse.retry }),
    );
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(routerMock.push).not.toHaveBeenCalled();
    view.rerender(
      <ContentReuseRetryAction
        run={runDetailDtoSchema.parse({
          ...run,
          input: { kind: "redacted" },
          internalSource: { state: "redacted", sourceRevision: 7 },
        })}
      />,
    );
    expect(
      within(screen.getByRole("dialog")).queryByText("Frozen saved master"),
    ).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByText("Saved title")).not.toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Reuse.retry }),
    );
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]?.[1]?.body).toBe(posts()[0]?.[1]?.body);
    expect(posts()[2]?.[1]?.headers).toEqual(posts()[0]?.[1]?.headers);
    expect(posts()[1]?.[1]?.body).toBe(posts()[0]?.[1]?.body);
    expect(posts()[1]?.[1]?.headers).toEqual(posts()[0]?.[1]?.headers);
    expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${RESULT}`);
  });
  it("missing frozen channels explain repair without admitting a doomed paid retry", async () => {
    mockApi.mockResolvedValue([]);
    render(<ContentReuseRetryAction run={makeRun()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.Reuse.retry }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Reuse.retryChannelUnavailable);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("redacted retained input offers no fresh paid retry and performs no reads or writes", () => {
    render(
      <ContentReuseRetryAction
        run={runDetailDtoSchema.parse({
          ...makeRun(),
          input: { kind: "redacted" },
          internalSource: { state: "redacted", sourceRevision: 7 },
        })}
      />,
    );
    expect(screen.getByText(en.Reuse.retryRedacted)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(mockApi).not.toHaveBeenCalled();
  });
});
