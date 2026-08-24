import { useTranslations } from "next-intl";

export default function LandingPage() {
  const t = useTranslations("Landing");
  return (
    <main style={{ fontFamily: "system-ui", padding: "4rem", maxWidth: 640 }}>
      <h1>{t("title")}</h1>
      <p>{t("tagline")}</p>
    </main>
  );
}
