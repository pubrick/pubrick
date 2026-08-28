import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { routing } from "@/i18n/routing";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// PWA install metadata. Icon/manifest paths are root-relative — every
// locale serves the same one, there is no per-locale manifest.
export const metadata: Metadata = {
  title: "Pubrick",
  description:
    "Pubrick — AI content factory: news in, drafts out, review queue, publish everywhere.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Pubrick",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// themeColor moved out of `metadata` into `viewport` (Next's current split —
// see the Viewport type in next/dist/lib/metadata/types). Two entries, one
// per `prefers-color-scheme`, matching the light/dark `--color-bg` tokens in
// globals.css (paper #f5f6f7 / dark ground #131416) so the OS chrome around
// the page (status bar, task switcher) never clashes with the page itself.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f7" },
    { media: "(prefers-color-scheme: dark)", color: "#131416" },
  ],
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  return (
    <html lang={locale}>
      <head>
        <script
          // Applies a stored explicit theme before first paint; system pref needs no attribute.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static, non-interpolated no-FOUC boot script (no user input)
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("pubrick-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}',
          }}
        />
      </head>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
