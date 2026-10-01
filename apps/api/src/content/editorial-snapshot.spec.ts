import { describe, expect, it } from "vitest";
import { type EditorialSnapshot, hashEditorialSnapshot } from "./editorial-snapshot";

const legacy: EditorialSnapshot = {
  orgId: "organization-a",
  itemId: "item-a",
  brandId: "brand-a",
  title: "Legacy review",
  body: "First paragraph.\n\nSecond paragraph.",
  coverMediaId: null,
  videoMediaId: null,
  imagesRevision: 0,
  images: [],
  status: "draft",
  channels: [
    {
      adaptationId: "adaptation-a",
      channelId: "channel-a",
      name: "Telegram",
      platform: "telegram",
      body: "Channel-specific copy.",
    },
  ],
};

describe("shared editorial review snapshot", () => {
  // Fixed receipts from the pre-extraction client-review serializer. Existing
  // review links must survive extraction, including its optional media keys.
  it.each([
    [0, null, "e467d0b54a9f05d1343ac6c2d84d133509217c1a48511171569949c154459570"],
    [2, null, "3d919226b6eaf58f843a6de6ed94f45472c49e1004503db8f5b85f8681a771ef"],
    [0, "video-a", "037b13bfc008a692ca63f11450c3237fa0f0196fcc929111325902b7af206bd2"],
    [2, "video-a", "09652e9642f772fde785b435cac205de343a06c18e80d3ee3ac1489dc3e4bfcc"],
  ] as const)(
    "preserves the legacy hash for revision %s and video %s",
    (imagesRevision, videoMediaId, expected) => {
      expect(hashEditorialSnapshot({ ...legacy, imagesRevision, videoMediaId })).toBe(expected);
    },
  );

  it("invalidates a verdict when a channel name or effective adaptation text changes", () => {
    const original = hashEditorialSnapshot(legacy);
    for (const change of [{ name: "Renamed" }, { body: "Revised channel copy." }]) {
      expect(
        hashEditorialSnapshot({
          ...legacy,
          channels: legacy.channels.map((channel) => ({ ...channel, ...change })),
        }),
      ).not.toBe(original);
    }
  });
});
