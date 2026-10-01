import { getTranslations } from "next-intl/server";
import { PublicHome } from "@/components/public-site/home";
import { publicMetadata } from "@/lib/public-site";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Marketing" });
  return publicMetadata(locale, "", t("home.metaTitle"), t("home.metaDescription"));
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <PublicHome locale={locale} />;
}
