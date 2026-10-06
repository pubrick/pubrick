import { metaPreparationDiscardSchema } from "@pubrick/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test/render";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import { MetaPreparations } from "./meta-preparations";

const itemId = "9168a9a7-c7d6-4e1f-9c0c-3601099f79e4";
const stage = {
  stageId: "ebad2852-cb20-44d4-921e-834a1bfe149b",
  adaptationId: "a86fbef4-bfad-4d88-bd1c-e0798b16353c",
  platform: "threads",
  phase: "preparation_unknown",
  attempt: 1,
  inputHash: "a".repeat(64),
  containerId: "123",
  channelName: "Studio Threads",
  reason: "preparation_receipt_lost",
  recoverable: true,
  createdAt: "2026-10-07T10:00:00.000Z",
};
const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const page = (stages: unknown[] = [stage], nextCursor: string | null = null) => ({
  stages,
  nextCursor,
});
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

async function confirm(user: ReturnType<typeof userEvent.setup>, locale: "en" | "ru" = "en") {
  const copy = locale === "en" ? en.MetaPreparations : ru.MetaPreparations;
  await user.click(await screen.findByRole("button", { name: copy.discard }));
  const dialog = within(screen.getByRole("dialog", { name: copy.confirmTitle }));
  await user.click(dialog.getByRole("checkbox", { name: copy.acknowledge }));
  await user.click(dialog.getByRole("button", { name: copy.discard }));
}

describe("explicit nonpublic Meta preparation recovery", () => {
  it("names actual preparation evidence without an invented inspection link", async () => {
    vi.mocked(fetch).mockResolvedValue(body(page()));
    render(<MetaPreparations itemId={itemId} canRecover />);
    expect(await screen.findByText("Preparation ID: 123")).toBeVisible();
    expect(screen.getByText(`Record: ${stage.stageId}`)).toBeVisible();
    expect(screen.getByText(en.MetaPreparations.phases.preparation_unknown)).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("requires the displayed record and separate acknowledgment before one discard POST", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(body(page()))
      .mockResolvedValueOnce(body({ stageId: stage.stageId, phase: "cancelled" }))
      .mockResolvedValueOnce(body(page([{ ...stage, phase: "cancelled", recoverable: false }])));
    render(<MetaPreparations itemId={itemId} canRecover />);
    const user = userEvent.setup();
    const entry = await screen.findByRole("button", { name: en.MetaPreparations.discard });
    expect(entry).toHaveClass("min-h-11");
    await user.click(entry);
    const dialog = within(screen.getByRole("dialog", { name: en.MetaPreparations.confirmTitle }));
    const commit = dialog.getByRole("button", { name: en.MetaPreparations.discard });
    expect(commit).toBeDisabled();
    expect(posts()).toHaveLength(0);
    expect(dialog.getByText(new RegExp(stage.stageId))).toBeVisible();
    const acknowledgment = dialog.getByRole("checkbox", { name: en.MetaPreparations.acknowledge });
    expect(acknowledgment.closest("label")).toHaveClass("min-h-11");
    await user.click(acknowledgment);
    await user.dblClick(commit);
    await screen.findByText(en.MetaPreparations.discarded);
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0] ?? [];
    expect(String(url)).toContain(
      `/api/content/${itemId}/meta-preparations/${stage.stageId}/discard`,
    );
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({
      expectedAttempt: stage.attempt,
      expectedInputHash: stage.inputHash,
      acknowledgeNonpublicPreparation: true,
    });
    expect(metaPreparationDiscardSchema.parse(sent)).toEqual(sent);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(
      false,
    );
    expect(
      screen.queryByRole("button", { name: en.MetaPreparations.discard }),
    ).not.toBeInTheDocument();
  });
  it("cancelling the dialog never writes and re-opening never retains acknowledgment", async () => {
    vi.mocked(fetch).mockResolvedValue(body(page()));
    render(<MetaPreparations itemId={itemId} canRecover />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.MetaPreparations.discard }));
    await user.click(screen.getByRole("checkbox", { name: en.MetaPreparations.acknowledge }));
    await user.click(screen.getByRole("button", { name: en.MetaPreparations.cancel }));
    expect(posts()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: en.MetaPreparations.discard }));
    expect(
      screen.getByRole("checkbox", { name: en.MetaPreparations.acknowledge }),
    ).not.toBeChecked();
  });
  it.each([
    "final_unknown",
    "published_without_receipt",
    "published",
    "waiting",
    "preparation_intent",
  ])("shows %s honestly and never offers preparation discard", async (phase) => {
    vi.mocked(fetch).mockResolvedValue(body(page([{ ...stage, phase, recoverable: false }])));
    render(<MetaPreparations itemId={itemId} canRecover />);
    expect(
      await screen.findByText(
        en.MetaPreparations.phases[phase as keyof typeof en.MetaPreparations.phases],
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: en.MetaPreparations.discard }),
    ).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("requires the server's recovery eligibility even for a saved uncertain preparation", async () => {
    vi.mocked(fetch).mockResolvedValue(body(page([{ ...stage, recoverable: false }])));
    render(<MetaPreparations itemId={itemId} canRecover />);
    expect(await screen.findByText(en.MetaPreparations.blocked)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: en.MetaPreparations.discard }),
    ).not.toBeInTheDocument();
  });
  it("keeps author-only users read-only even when recovery is otherwise eligible", async () => {
    vi.mocked(fetch).mockResolvedValue(body(page()));
    render(<MetaPreparations itemId={itemId} canRecover={false} />);
    await screen.findByText(en.MetaPreparations.phases.preparation_unknown);
    expect(
      screen.queryByRole("button", { name: en.MetaPreparations.discard }),
    ).not.toBeInTheDocument();
  });
  it("clears stale confirmation after a conflict and requires explicit reload with a fresh acknowledgment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(body(page()))
      .mockResolvedValueOnce(
        body({ code: "meta_preparation_changed", message: "Server prose" }, 409),
      )
      .mockResolvedValueOnce(body(page([{ ...stage, attempt: 2, inputHash: "b".repeat(64) }])));
    render(<MetaPreparations itemId={itemId} canRecover />, { locale: "ru" });
    const user = userEvent.setup();
    await confirm(user, "ru");
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.meta_preparation_changed);
    expect(screen.queryByText("Studio Threads")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: ru.MetaPreparations.reload }));
    await user.click(await screen.findByRole("button", { name: ru.MetaPreparations.discard }));
    const dialog = within(screen.getByRole("dialog", { name: ru.MetaPreparations.confirmTitle }));
    expect(
      dialog.getByRole("checkbox", { name: ru.MetaPreparations.acknowledge }),
    ).not.toBeChecked();
    expect(dialog.getByRole("button", { name: ru.MetaPreparations.discard })).toBeDisabled();
    expect(posts()).toHaveLength(1);
  });
  it("separates a successful discard from a failed history refresh", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(body(page()))
      .mockResolvedValueOnce(body({ stageId: stage.stageId, phase: "cancelled" }))
      .mockResolvedValueOnce(body({ message: "Internal failure" }, 500));
    render(<MetaPreparations itemId={itemId} canRecover />);
    await confirm(userEvent.setup());
    expect(await screen.findByText(en.MetaPreparations.discarded)).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(en.MetaPreparations.refreshFailed);
    expect(posts()).toHaveLength(1);
  });
  it("loads more only on request and never treats the first history page as complete", async () => {
    const older = {
      ...stage,
      stageId: "316d3d4f-c2b9-4e63-861c-1711b7ce7520",
      phase: "cancelled",
      recoverable: false,
      containerId: "789",
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(body(page([stage], stage.stageId)))
      .mockResolvedValueOnce(body(page([older])));
    render(<MetaPreparations itemId={itemId} canRecover />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.MetaPreparations.loadMore }));
    expect(await screen.findByText("Preparation ID: 789")).toBeVisible();
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(`?cursor=${stage.stageId}`);
    expect(
      screen.queryByRole("button", { name: en.MetaPreparations.loadMore }),
    ).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("drops a late discard result when the content resource changes", async () => {
    let finish!: (value: Response) => void;
    const otherId = "1e8b4fa2-688d-4487-b83e-fc26838230bd";
    vi.mocked(fetch)
      .mockResolvedValueOnce(body(page()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(body(page([{ ...stage, channelName: "Other post" }])));
    const view = render(<MetaPreparations itemId={itemId} canRecover />);
    await confirm(userEvent.setup());
    view.rerender(<MetaPreparations itemId={otherId} canRecover />);
    await screen.findByText("Other post");
    await act(async () => finish(body({ stageId: stage.stageId, phase: "cancelled" })));
    expect(screen.queryByText(en.MetaPreparations.discarded)).not.toBeInTheDocument();
    expect(screen.getByText("Other post")).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("removes confirmation when editorial permission disappears", async () => {
    vi.mocked(fetch).mockResolvedValue(body(page()));
    const view = render(<MetaPreparations itemId={itemId} canRecover />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.MetaPreparations.discard }));
    view.rerender(<MetaPreparations itemId={itemId} canRecover={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts()).toHaveLength(0);
  });
  it("rejects unexpected successful mutation identities without advancing the displayed preparation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(body(page()))
      .mockResolvedValueOnce(
        body({ stageId: "316d3d4f-c2b9-4e63-861c-1711b7ce7520", phase: "cancelled" }),
      );
    render(<MetaPreparations itemId={itemId} canRecover />);
    await confirm(userEvent.setup());
    expect(await screen.findByRole("alert")).toHaveTextContent(en.MetaPreparations.failed);
    expect(screen.queryByText(en.MetaPreparations.discarded)).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });
});
