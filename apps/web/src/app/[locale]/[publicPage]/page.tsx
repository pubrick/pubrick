import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicDetail, pageCopyKey } from "@/components/public-site/detail";
import { PUBLIC_PAGES, type PublicPage, publicMetadata } from "@/lib/public-site";

// Keep installation-specific canonical URLs at runtime, outside the image build.
export const dynamic = "force-dynamic";
type Params = { locale: string; publicPage: string };

function validatedPage(value: string): Exclude<PublicPage, ""> {
  const page = PUBLIC_PAGES.find((candidate) => candidate !== "" && candidate === value);
  if (!page) notFound();
  return page;
}

export async function generateMetadata({ params }: { params: Promise<Params> }) {
  const { locale, publicPage } = await params;
  const page = validatedPage(publicPage);
  const t = await getTranslations({ locale, namespace: "Marketing" });
  const key = pageCopyKey(page);
  return publicMetadata(locale, page, t(`${key}.metaTitle`), t(`${key}.metaDescription`));
}

export default async function PublicPageRoute({ params }: { params: Promise<Params> }) {
  const { locale, publicPage } = await params;
  return <PublicDetail locale={locale} page={validatedPage(publicPage)} />;
}
