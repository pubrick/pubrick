import type { Metadata } from "next";
import ClientReviewPage from "./review-client";

export const metadata: Metadata = {
  title: "Review draft · Pubrick",
  robots: { index: false, follow: false, noarchive: true },
};

export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ClientReviewPage token={token} />;
}
