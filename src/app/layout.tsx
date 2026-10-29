import type { Metadata, Viewport } from "next";
import { Sora, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrandProvider } from "@/components/brand";
import { getBrand } from "@/lib/brand";
import { rootMetadata } from "@/lib/brand-metadata";
import { StaleBuildReload } from "@/components/stale-build-reload";
import "./globals.css";
import "./liquid-glass.css";
import { GlassDefs } from "@/components/shared/glass-defs";

// Porcelain Signal type: Sora for titles and big numbers, Instrument Sans for UI, JetBrains Mono for data.
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", weight: ["400", "500", "600", "700"] });
const instrumentSans = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument", weight: ["400", "500", "600", "700"] });

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

// The name on the tab, the link preview, the icons and the home-screen app: lib/brand-metadata.ts (the agency's, never the product's on
// a client page; white label, D 2026-10-10).
export function generateMetadata(): Metadata { return rootMetadata(); }

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F2F2F7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* a split-screen pane (components/layout/split-view.tsx) shows the page alone: marked before paint, so the chrome never flashes */}
        <script dangerouslySetInnerHTML={{ __html: "try{if(window.self!==window.top){document.documentElement.dataset.embed='1';var s=document.createElement('style');s.textContent='[data-chrome]{display:none!important}';document.head.appendChild(s)}}catch(e){}" }} />
      </head>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <StaleBuildReload />
        <GlassDefs />
        <SessionProvider>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
            <BrandProvider brand={getBrand()}>
              <TooltipProvider>
                {children}
              </TooltipProvider>
            </BrandProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
