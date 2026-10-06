import { createHash } from "node:crypto";

type Snapshot = {
  title: string | null;
  body: string;
  richBody: unknown;
  bodyRevision: number;
  coverMediaId: string | null;
  videoMediaId: string | null;
  imagesRevision: number | null;
  status: string;
  adaptations: readonly {
    id: string;
    channelId: string;
    body: string | null;
    hashtags: string[];
    cta: string | null;
    status: string;
    scheduledAt: Date | string | null;
    attemptCount: number;
  }[];
};

/** Exact saved publication inputs; review notes and connection rotation are not content edits. */
export function postingReviewFingerprint(snapshot: Snapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: snapshot.title,
        body: snapshot.body,
        richBody: snapshot.richBody,
        bodyRevision: snapshot.bodyRevision,
        coverMediaId: snapshot.coverMediaId,
        videoMediaId: snapshot.videoMediaId,
        imagesRevision: snapshot.imagesRevision,
        status: snapshot.status,
        adaptations: [...snapshot.adaptations]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({
            id: row.id,
            channelId: row.channelId,
            body: row.body,
            hashtags: row.hashtags,
            cta: row.cta,
            status: row.status,
            scheduledAt: row.scheduledAt === null ? null : new Date(row.scheduledAt).toISOString(),
            attemptCount: row.attemptCount,
          })),
      }),
    )
    .digest("hex");
}
