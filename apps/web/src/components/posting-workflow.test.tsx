import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import { act, render, screen, waitFor } from "@/test/render";
import { PostingQueueAction } from "./posting-queue-action";
import { PostingScheduleSettings } from "./posting-schedule-settings";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
const channelId = "4e2be789-a1a2-4567-8ef5-b7d4b77fba01";
const contentItemId = "4e2be789-a1a2-4567-8ef5-b7d4b77fba02";
const fingerprint = "a".repeat(64);
const settings = { channelId, revision: 2, timezone: "UTC", slots: [] };
const preview = {
  token: "server-preview-token",
  expiresAt: "2030-01-01T08:10:00.000Z",
  destinations: [
    {
      channelId,
      channelName: "My channel",
      platform: "telegram",
      adaptationId: "4e2be789-a1a2-4567-8ef5-b7d4b77fba03",
      timezone: "UTC",
      scheduledAt: "2030-01-01T09:00:00.000Z",
    },
  ],
};
beforeEach(() => vi.mocked(api).mockReset());
function callAt(index: number) {
  const call = vi.mocked(api).mock.calls[index];
  if (!call) throw new Error(`Expected API call ${index}`);
  return call;
}

describe("weekly posting settings", () => {
  it("retains unsaved input after a failed save and reloads the revision without replacing it", async () => {
    vi.mocked(api).mockResolvedValueOnce(settings);
    render(
      <PostingScheduleSettings channelId={channelId} channelName="My channel" onClose={vi.fn()} />,
    );
    await screen.findByLabelText("Time zone");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Time", { exact: true }), {
      target: { value: "14:45" },
    });
    vi.mocked(api).mockRejectedValueOnce(new ApiError(409, "stale", false, "schedule_changed"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Time", { exact: true })).toHaveValue("14:45");
    expect(JSON.parse(callAt(1)[1]?.body as string)).toEqual({
      expectedRevision: 2,
      timezone: "UTC",
      slots: [{ weekday: 1, localTime: "14:45" }],
    });
    vi.mocked(api).mockResolvedValueOnce({ ...settings, revision: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByLabelText("Time", { exact: true })).toHaveValue("14:45"),
    );
    vi.mocked(api).mockResolvedValueOnce({
      ...settings,
      revision: 4,
      slots: [{ weekday: 1, localTime: "14:45" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(JSON.parse(callAt(3)[1]?.body as string).expectedRevision).toBe(3);
  });
  it("requires a discard choice before closing an edited schedule", async () => {
    vi.mocked(api).mockResolvedValueOnce(settings);
    const onClose = vi.fn();
    render(
      <PostingScheduleSettings channelId={channelId} channelName="My channel" onClose={onClose} />,
    );
    await screen.findByLabelText("Time zone");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("next-slot confirmation", () => {
  const props = {
    contentItemId,
    brandId: channelId,
    reviewFingerprint: fingerprint,
    disabled: false,
  };
  it("previews without approving and submits only the server token after explicit confirmation", async () => {
    vi.mocked(api).mockResolvedValueOnce(preview).mockResolvedValueOnce({});
    const onScheduled = vi.fn().mockResolvedValue(undefined);
    render(<PostingQueueAction {...props} onScheduled={onScheduled} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("time")).toHaveAttribute(
      "datetime",
      preview.destinations[0]?.scheduledAt,
    );
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onScheduled).toHaveBeenCalledOnce());
    expect(callAt(1)[0]).toBe(`/api/content/${contentItemId}/approve`);
    expect(JSON.parse(callAt(1)[1]?.body as string)).toEqual({
      queuePreviewToken: preview.token,
    });
  });
  it("drops an in-flight preview if the visible saved content changes", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onScheduled = vi.fn();
    const view = render(<PostingQueueAction {...props} onScheduled={onScheduled} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    view.rerender(
      <PostingQueueAction
        {...props}
        reviewFingerprint={"b".repeat(64)}
        onScheduled={onScheduled}
      />,
    );
    await act(async () => resolve(preview));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
  it("closes an existing confirmation when editing becomes unsaved", async () => {
    vi.mocked(api).mockResolvedValueOnce(preview);
    const onScheduled = vi.fn();
    const view = render(<PostingQueueAction {...props} onScheduled={onScheduled} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await screen.findByRole("dialog");
    view.rerender(<PostingQueueAction {...props} disabled onScheduled={onScheduled} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    view.rerender(<PostingQueueAction {...props} onScheduled={onScheduled} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
