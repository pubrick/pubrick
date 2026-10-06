import {
  type InboxDetailDto,
  inboxReplyResolutionSchema,
  inboxReplySchema,
  refusalBody,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InboxConversationPage from "@/app/[locale]/brands/[id]/inbox/[conversationId]/page";
import { signedInOrganization, signedInSession } from "@/test/auth-client.stub";
import { act, render, renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import { InboxConversation, InboxList } from "./inbox-workspace";

function fixtureRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("Expected populated UI fixture");
  return row;
}
const brand = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const conversation = "ddc835ad-6cbf-41a1-94d1-134948608aac";
const message = "f3b28480-f9d1-4e86-b95a-201ac58582b8";
const preview = "ea2436a0-5bfa-4ad4-83ba-e39244a49258";
const receipt = "95dd99ad-9ec3-4d15-8d0b-8a49a8a9286c";
const at = "2026-10-01T12:00:00.000Z";
const detail = (): InboxDetailDto => ({
  conversation: {
    id: conversation,
    publicationId: receipt,
    postUrl: "https://t.me/pubrick_test/9",
    title: "Saved publication",
    activityRevision: 1,
    unread: true,
    resolved: false,
    lastActivityAt: at,
    collectionRevision: 1,
    collectedAt: at,
    hasOlder: false,
    latestWindowLimit: 50,
    collectionError: null,
  },
  messages: {
    rows: [
      {
        id: message,
        providerMessageId: 51,
        body: "A real short comment",
        bodyTruncated: false,
        revision: 0,
        reviewFingerprint: "a".repeat(64),
        publishedAt: at,
        editedAt: null,
      },
    ],
    nextCursor: null,
  },
  replies: [],
  accountConnected: true,
  applicationConfigured: true,
  publicationAvailable: true,
  canReply: true,
  canCollect: true,
  blockedReply: false,
});
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
beforeEach(() => {
  signedInSession();
});
describe("supported conversation inbox UX", () => {
  it("shows bounded capability and uses server filters without local sorting", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        return response({ rows: [detail().conversation], nextCursor: null });
      }),
    );
    render(<InboxList brandId={brand} />);
    expect(await screen.findByText("Saved publication")).toBeVisible();
    expect(screen.getByText(en.Inbox.scope)).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: en.Inbox.filter.resolved }));
    await waitFor(() => expect(calls.some((url) => url.includes("filter=resolved"))).toBe(true));
    expect(screen.getByRole("link", { name: /Saved publication/ })).toHaveAttribute(
      "href",
      `/en/brands/${brand}/inbox/${conversation}`,
    );
  });

  it("acknowledges saved read and resolved state visibly using the viewed activity revision", async () => {
    const current = detail();
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        if (init?.method === "POST") {
          const input = JSON.parse(String(init.body));
          writes.push(input);
          current.conversation.unread = false;
          if (input.action === "resolve") current.conversation.resolved = true;
          return response(current.conversation);
        }
        return response(current);
      }),
    );
    render(<InboxConversation brandId={brand} conversationId={conversation} />);
    await screen.findByText("Saved publication");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Inbox.markRead }));
    await screen.findByText(en.Inbox.read);
    expect(screen.getByRole("button", { name: en.Inbox.markRead })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: en.Inbox.resolve }));
    expect(await screen.findByText(en.Inbox.resolved)).toBeVisible();
    expect(writes).toEqual([
      { action: "read", expectedActivityRevision: 1 },
      { action: "resolve", expectedActivityRevision: 1 },
    ]);
  });
  it("reviews the exact target, sender and body, then sends the complete shared-schema request", async () => {
    const writes: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          writes.push({ url: String(url), body });
          if (String(url).endsWith("/sender"))
            return response({
              id: preview,
              accountLabel: "@humanwriter",
              expiresAt: "2099-01-01T00:00:00.000Z",
            });
          return response({ id: receipt, status: "sent", externalMessageId: 991 });
        }
        return response(detail());
      }),
    );
    render(<InboxConversation brandId={brand} conversationId={conversation} />);
    await screen.findByText("Saved publication");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Inbox.replyTo }));
    await user.type(screen.getByLabelText(en.Inbox.replyBody), "Reviewed answer");
    await user.click(screen.getByRole("button", { name: en.Inbox.reviewSend }));
    const dialog = await screen.findByRole("dialog", { name: en.Inbox.confirmSend });
    expect(within(dialog).getByText("Sending account: @humanwriter")).toBeVisible();
    expect(within(dialog).getByText("A real short comment")).toBeVisible();
    expect(writes.map((w) => w.url)).toEqual([`/api/brands/${brand}/inbox/sender`]);
    await user.click(within(dialog).getByRole("button", { name: en.Inbox.send }));
    await waitFor(() => expect(writes).toHaveLength(2));
    const sent = fixtureRow(writes[1]).body;
    expect(sent).toEqual({
      operationKey: expect.any(String),
      senderPreviewId: preview,
      messageId: message,
      expectedMessageRevision: 0,
      expectedMessageFingerprint: "a".repeat(64),
      body: "Reviewed answer",
    });
    expect(inboxReplySchema.parse(sent)).toEqual(sent);
    await waitFor(() => expect(screen.getByLabelText(en.Inbox.replyBody)).toHaveValue(""));
  });
  it("preserves unsent text on reload, refuses a changed message and confirms before leaving", async () => {
    let current = detail();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(current)),
    );
    render(<InboxConversation brandId={brand} conversationId={conversation} />);
    await screen.findByText("Saved publication");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Inbox.replyTo }));
    await user.type(screen.getByLabelText(en.Inbox.replyBody), "Do not lose this");
    current = {
      ...current,
      messages: {
        rows: [{ ...fixtureRow(current.messages.rows[0]), revision: 1, body: "Changed comment" }],
        nextCursor: null,
      },
    };
    await user.click(screen.getByRole("button", { name: en.Inbox.reload }));
    expect(await screen.findByText(en.Inbox.reviewSelection)).toBeVisible();
    expect(screen.getByLabelText(en.Inbox.replyBody)).toHaveValue("Do not lose this");
    expect(screen.getByRole("button", { name: en.Inbox.reviewSend })).toBeDisabled();
    await user.click(screen.getByRole("link", { name: en.Inbox.backInbox }));
    expect(screen.getByRole("dialog", { name: en.Inbox.unsavedTitle })).toBeVisible();
    await user.click(screen.getByRole("button", { name: en.Inbox.keepWriting }));
    expect(screen.getByLabelText(en.Inbox.replyBody)).toHaveValue("Do not lose this");
  });
  it("does not carry selected messages or outgoing text into a different brand route", async () => {
    signedInOrganization("Inbox team", "editor");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(detail())),
    );
    const { rerender } = await renderAsync(
      <InboxConversationPage
        params={Promise.resolve({ id: brand, conversationId: conversation })}
      />,
    );
    await screen.findByText("Saved publication");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Inbox.replyTo }));
    await user.type(screen.getByLabelText(en.Inbox.replyBody), "Brand-scoped text");
    const next = Promise.resolve({
      id: "58d92ee4-39f7-44cb-a69d-ec5e81c15e63",
      conversationId: conversation,
    });
    await act(async () => {
      rerender(<InboxConversationPage params={next} />);
      await next;
    });
    await screen.findByText("Saved publication");
    expect(screen.getByLabelText(en.Inbox.replyBody)).toHaveValue("");
    expect(screen.getByRole("button", { name: en.Inbox.reviewSend })).toBeDisabled();
  });
  it("keeps a known unsent reply and requires fresh sender review before a new operation", async () => {
    const sent: Record<string, unknown>[] = [];
    let previews = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init?: RequestInit) => {
        if (init?.method !== "POST") return response(detail());
        if (String(url).endsWith("/sender")) {
          previews++;
          return response({
            id: previews === 1 ? preview : "479e6e53-c2b8-4f9e-a4cd-563dc8932fd3",
            accountLabel: "@humanwriter",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
        }
        sent.push(JSON.parse(String(init.body)));
        return response({ id: receipt, status: sent.length === 1 ? "failed" : "sent" });
      }),
    );
    render(<InboxConversation brandId={brand} conversationId={conversation} />);
    await screen.findByText("Saved publication");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Inbox.replyTo }));
    await user.type(screen.getByLabelText(en.Inbox.replyBody), "Keep this reviewed answer");
    await user.click(screen.getByRole("button", { name: en.Inbox.reviewSend }));
    await user.click(
      within(await screen.findByRole("dialog", { name: en.Inbox.confirmSend })).getByRole(
        "button",
        { name: en.Inbox.send },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.Inbox.confirmSend })).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText(en.Inbox.replyBody)).toHaveValue("Keep this reviewed answer");
    await user.click(screen.getByRole("button", { name: en.Inbox.reviewSend }));
    expect(previews).toBe(2);
    expect(sent).toHaveLength(1);
    await user.click(
      within(await screen.findByRole("dialog", { name: en.Inbox.confirmSend })).getByRole(
        "button",
        { name: en.Inbox.send },
      ),
    );
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(fixtureRow(sent[1]).operationKey).not.toBe(fixtureRow(sent[0]).operationKey);
    expect(fixtureRow(sent[1]).senderPreviewId).not.toBe(fixtureRow(sent[0]).senderPreviewId);
    expect(fixtureRow(sent[1]).body).toBe(fixtureRow(sent[0]).body);
    await waitFor(() => expect(screen.getByLabelText(en.Inbox.replyBody)).toHaveValue(""));
  });
  it("blocks unknown resend and requires inspected-provider acknowledgement with exact receipt", async () => {
    const current = detail();
    current.blockedReply = true;
    current.replies = [
      {
        id: receipt,
        messageId: message,
        body: "Original uncertain reply",
        status: "unknown",
        senderLabel: "@humanwriter",
        targetMessageBody: "Original target text",
        targetProviderMessageId: 51,
        externalMessageId: null,
        externalUrl: null,
        createdAt: at,
        finishedAt: at,
        canResolve: true,
        providerReceipts: [],
        receiptContradiction: false,
      },
    ];
    const writes: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          writes.push({ url: String(url), body });
          if (String(url).endsWith("/sender"))
            return response({
              id: preview,
              accountLabel: "@humanwriter",
              expiresAt: "2099-01-01T00:00:00.000Z",
            });
          return response({ status: "confirmed_not_sent" });
        }
        return response(current);
      }),
    );
    render(<InboxConversation brandId={brand} conversationId={conversation} />);
    await screen.findByText("Saved publication");
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: en.Inbox.reviewSend })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: en.Inbox.settle }));
    const dialog = await screen.findByRole("dialog", { name: en.Inbox.settle });
    const no = within(dialog).getByRole("button", { name: en.Inbox.notSent });
    expect(no).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: en.Inbox.inspectedProvider }));
    await user.click(no);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      url: `/api/brands/${brand}/inbox/${conversation}/replies/${receipt}/resolve`,
      body: {
        senderPreviewId: preview,
        expectedStatus: "unknown",
        outcome: "not_sent",
        inspectedProvider: true,
      },
    });
    expect(inboxReplyResolutionSchema.parse(fixtureRow(writes[1]).body)).toEqual(
      fixtureRow(writes[1]).body,
    );
  });
  it("shows contradictory late acceptance and one link per recorded provider URL", async () => {
    const current = detail();
    current.replies = [
      {
        id: receipt,
        messageId: message,
        body: "Reviewed reply",
        status: "confirmed_not_sent",
        senderLabel: "@humanwriter",
        targetMessageBody: "A real short comment",
        targetProviderMessageId: 51,
        externalMessageId: 991,
        externalUrl: "https://t.me/discussion_test/991",
        createdAt: at,
        finishedAt: at,
        canResolve: false,
        receiptContradiction: true,
        providerReceipts: [
          { messageId: 991, url: "https://t.me/discussion_test/991", receivedAt: at },
        ],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(current)),
    );
    render(<InboxConversation brandId={brand} conversationId={conversation} />);
    await screen.findByText("Saved publication");
    expect(screen.getByRole("alert")).toHaveTextContent(en.Inbox.receiptContradiction);
    expect(screen.getAllByRole("link", { name: en.Inbox.inspectReply })).toHaveLength(1);
    expect(screen.getByRole("link", { name: en.Inbox.inspectReply })).toHaveAttribute(
      "href",
      "https://t.me/discussion_test/991",
    );
  });
  it("translates a real coded stale-sender refusal in Russian and preserves the reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) =>
        init?.method === "POST"
          ? response(refusalBody(409, "inbox_snapshot_changed", "Sender changed before send"), 409)
          : response(detail()),
      ),
    );
    render(<InboxConversation brandId={brand} conversationId={conversation} />, { locale: "ru" });
    await screen.findByText("Saved publication");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: ru.Inbox.replyTo }));
    await user.type(screen.getByLabelText(ru.Inbox.replyBody), "Human draft");
    await user.click(screen.getByRole("button", { name: ru.Inbox.reviewSend }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.inbox_snapshot_changed);
    expect(screen.getByLabelText(ru.Inbox.replyBody)).toHaveValue("Human draft");
  });
});
