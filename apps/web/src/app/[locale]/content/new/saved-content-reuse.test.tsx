import { contentReuseCreateSchema, contentReuseSourcePreviewSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInOrganization, signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../messages/en.json";
import ru from "../../../../../messages/ru.json";
import { SavedContentReuse } from "./saved-content-reuse";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

import { ApiError, api } from "@/lib/api";

const mockApi = vi.mocked(api);
const SOURCE = "11111111-1111-4111-8111-111111111111";
const BRAND = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
let preview = contentReuseSourcePreviewSchema.parse({
  id: SOURCE,
  brandId: BRAND,
  title: "Stored title",
  bodyRevision: 4,
  material: "Saved master body.",
  origin: "human",
  status: "draft",
  digest: "a".repeat(64),
});
beforeEach(() => {
  signedInSession();
  signedInOrganization();
  preview = { ...preview, bodyRevision: 4, digest: "a".repeat(64) };
  mockApi.mockReset();
  mockApi.mockImplementation(async (path, init) => {
    if (init?.method === "POST") return { id: RUN, status: "queued" };
    if (path.endsWith("/reuse-source")) return preview;
    if (path.startsWith("/api/channels?"))
      return [{ id: CHANNEL, name: "Manual", platform: "vc_ru" }];
    throw new Error(`Unexpected fixture request ${path}`);
  });
});
const posts = () => mockApi.mock.calls.filter(([, init]) => init?.method === "POST");
async function prepare(locale: "en" | "ru" = "en") {
  render(<SavedContentReuse sourceId={SOURCE} />, { locale });
  await screen.findByTestId("reuse-source-preview");
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: /Manual/ }));
  await user.type(
    screen.getByLabelText(locale === "ru" ? ru.ContentNew.briefLabel : en.ContentNew.briefLabel),
    "Different audience",
  );
  await user.click(
    screen.getByRole("button", { name: locale === "ru" ? ru.Reuse.generate : en.Reuse.generate }),
  );
  return { user, dialog: screen.getByRole("dialog") };
}
describe("saved master compose", () => {
  it("preview, choices, modal opening and cancel produce no generation; confirmed input is a strict shared DTO", async () => {
    const { user, dialog } = await prepare();
    expect(posts()).toHaveLength(0);
    expect(within(dialog).getByRole("button", { name: en.Reuse.generate })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: en.Reuse.cancel }));
    expect(posts()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: en.Reuse.generate }));
    await user.click(screen.getByRole("checkbox", { name: en.Reuse.consent }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Reuse.generate }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    const first = posts()[0];
    if (!first) throw new Error("Confirmed request was not sent");
    const [path, init] = first;
    const parsed = contentReuseCreateSchema.parse(JSON.parse(init?.body as string));
    expect(path).toBe(`/api/content/${SOURCE}/reuse`);
    expect(parsed).toMatchObject({
      expectedSourceRevision: 4,
      expectedSourceDigest: preview.digest,
      channelIds: [CHANNEL],
      contentType: "social_post",
      brief: "Different audience",
      allowPaidGeneration: true,
      consentVersion: "byok-paid-generation-v1",
    });
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "allowPaidGeneration",
        "brief",
        "channelIds",
        "consentVersion",
        "contentType",
        "expectedSourceDigest",
        "expectedSourceRevision",
      ].sort(),
    );
    expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${RUN}`);
  });
  it("unknown outcomes freeze form choices and replay the exact confirmed body and key", async () => {
    const { user, dialog } = await prepare();
    mockApi.mockRejectedValueOnce(new ApiError(0, "Synthetic lost response"));
    await user.click(within(dialog).getByRole("checkbox", { name: en.Reuse.consent }));
    await user.click(within(dialog).getByRole("button", { name: en.Reuse.generate }));
    await screen.findAllByText(en.Reuse.uncertain);
    expect(screen.getByLabelText(en.ContentNew.briefLabel)).toBeDisabled();
    mockApi.mockRejectedValueOnce(
      new ApiError(403, "Synthetic expired brand authority", false, "forbidden"),
    );
    await user.click(within(dialog).getByRole("button", { name: en.Reuse.retry }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(screen.getByLabelText(en.ContentNew.briefLabel)).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: en.Reuse.retry }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]?.[1]?.headers).toEqual(posts()[0]?.[1]?.headers);
    expect(posts()[2]?.[1]?.body).toBe(posts()[0]?.[1]?.body);
    expect(posts()[1]?.[1]?.body).toBe(posts()[0]?.[1]?.body);
    expect(posts()[1]?.[1]?.headers).toEqual(posts()[0]?.[1]?.headers);
    expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${RUN}`);
  });
  it.each([401, 403])(
    "initial auth refusal %s retains the confirmed identity for recovery",
    async (status) => {
      const { user, dialog } = await prepare();
      mockApi.mockRejectedValueOnce(new ApiError(status, "Synthetic authority refusal"));
      await user.click(within(dialog).getByRole("checkbox", { name: en.Reuse.consent }));
      await user.click(within(dialog).getByRole("button", { name: en.Reuse.generate }));
      await screen.findAllByText(en.Reuse.uncertain);
      await user.click(within(dialog).getByRole("button", { name: en.Reuse.retry }));
      await waitFor(() => expect(posts()).toHaveLength(2));
      expect(posts()[1]?.[1]?.body).toBe(posts()[0]?.[1]?.body);
      expect(posts()[1]?.[1]?.headers).toEqual(posts()[0]?.[1]?.headers);
    },
  );
  it("Russian source change keeps choices, explicitly reloads preview and requires renewed consent", async () => {
    const { user, dialog } = await prepare("ru");
    mockApi.mockRejectedValueOnce(
      new ApiError(409, "English provider-independent refusal", false, "reuse_source_changed"),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: ru.Reuse.consent }));
    await user.click(within(dialog).getByRole("button", { name: ru.Reuse.generate }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.reuse_source_changed);
    expect(screen.getByLabelText(ru.ContentNew.briefLabel)).toHaveValue("Different audience");
    expect(screen.getByRole("checkbox", { name: /Manual/ })).toBeChecked();
    expect(screen.getByRole("button", { name: ru.Reuse.generate })).toBeDisabled();
    preview = { ...preview, bodyRevision: 5, digest: "b".repeat(64) };
    await user.click(screen.getByRole("button", { name: ru.Reuse.refresh }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ru.Reuse.generate })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: ru.Reuse.generate }));
    expect(screen.getByRole("checkbox", { name: ru.Reuse.consent })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: ru.Reuse.consent }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: ru.Reuse.generate }),
    );
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]?.[1]?.headers).not.toEqual(posts()[0]?.[1]?.headers);
    expect(JSON.parse(posts()[1]?.[1]?.body as string)).toMatchObject({
      expectedSourceRevision: 5,
      expectedSourceDigest: "b".repeat(64),
    });
  });
  it("a deleted channel refresh preserves instructions and exposes the missing selection for repair", async () => {
    const { user, dialog } = await prepare();
    mockApi.mockRejectedValueOnce(
      new ApiError(400, "Synthetic removed channel", false, "channels_not_in_brand"),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: en.Reuse.consent }));
    await user.click(within(dialog).getByRole("button", { name: en.Reuse.generate }));
    await screen.findByRole("button", { name: en.Reuse.refresh });
    const replacement = "55555555-5555-4555-8555-555555555555";
    mockApi.mockImplementation(async (path, init) => {
      if (init?.method === "POST") return { id: RUN, status: "queued" };
      if (path.endsWith("/reuse-source")) return preview;
      return [{ id: replacement, name: "Replacement", platform: "vc_ru" }];
    });
    await user.click(screen.getByRole("button", { name: en.Reuse.refresh }));
    const missing = await screen.findByRole("checkbox", { name: en.Reuse.channelUnavailable });
    expect(missing).toBeChecked();
    expect(screen.getByLabelText(en.ContentNew.briefLabel)).toHaveValue("Different audience");
    await user.click(missing);
    await user.click(screen.getByRole("checkbox", { name: /Replacement/ }));
    await user.click(screen.getByRole("button", { name: en.Reuse.generate }));
    expect(screen.getByRole("checkbox", { name: en.Reuse.consent })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: en.Reuse.consent }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Reuse.generate }),
    );
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(posts()[1]?.[1]?.body as string).channelIds).toEqual([replacement]);
    expect(posts()[1]?.[1]?.headers).not.toEqual(posts()[0]?.[1]?.headers);
  });
  it("a synchronous double confirmation admits only one in-flight request", async () => {
    const { user, dialog } = await prepare();
    let release!: (value: unknown) => void;
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: en.Reuse.consent }));
    const confirm = within(dialog).getByRole("button", { name: en.Reuse.generate });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(posts()).toHaveLength(1);
    release({ id: RUN, status: "queued" });
    await waitFor(() => expect(routerMock.push).toHaveBeenCalled());
  });
});
