import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PublishService } from "./publish.service";

describe("reviewed publication title", () => {
  it.each(['Reviewed — <title> & "special"', "", null])(
    "passes the saved title %j without deriving a title from the body or topic",
    async (title) => {
      const job = { orgId: "reviewed-title-org", adaptationId: "reviewed-title-adaptation" };
      const repo = {
        load: vi.fn().mockResolvedValue({
          ...job,
          id: job.adaptationId,
          channelId: "reviewed-title-channel",
          status: "queued",
          body: "Reviewed channel-specific body",
          itemBody: "Saved master body",
          itemTitle: title,
          topicTitle: "An unreviewed topic title",
          itemBrandId: "reviewed-title-brand",
          channelBrandId: "reviewed-title-brand",
          itemStatus: "approved",
          platform: "telegram",
          coverMediaId: null,
          attemptCount: 0,
          scheduledAt: null,
          lateBySeconds: null,
        }),
        credentials: vi.fn().mockResolvedValue({ botToken: "fixture", chatId: "fixture" }),
        hasPublished: vi.fn().mockResolvedValue(false),
        markPublishing: vi.fn().mockResolvedValue(1),
        claimSend: vi.fn().mockResolvedValue({ id: "reviewed-title-claim", attempt: 1 }),
        markPublished: vi.fn().mockResolvedValue(true),
      };
      const publish = vi.fn().mockResolvedValue({
        externalId: "71",
        externalUrl: "https://example.com/posts/71",
      });
      const publisher = {
        platform: "telegram",
        credentialsSchema: z.object({ botToken: z.string(), chatId: z.string() }),
        publish,
      };
      const service = new PublishService(repo as never, () => publisher as never, "https://api", 0);
      await service.handle(job);
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]?.[1]).toEqual({
        text: "Reviewed channel-specific body",
        ...(title === null ? {} : { title }),
      });
    },
  );
});
