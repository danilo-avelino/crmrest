import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import { OG_IMAGE, SITE_NAME, SITE_URL } from "@/lib/site";
import { THEME_SCRIPT } from "@/lib/theme";
import { cn } from "@/lib/utils";
import "./globals.css";

// Fontes do design: Inter na interface, Fraunces (com eixo de tamanho óptico) nos títulos.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const fraunces = Fraunces({ subsets: ["latin"], axes: ["opsz"], variable: "--font-fraunces" });

export const metadata: Metadata = {
  // Base das URLs absolutas (canonical, Open Graph) em todas as páginas do app.
  metadataBase: new URL(SITE_URL),
  title: "Dish Desk",
  description: "Atendimento omnichannel para restaurantes",
  openGraph: { type: "website", locale: "pt_BR", siteName: SITE_NAME, images: [OG_IMAGE] },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // O script do tema troca a classe do <html> antes do React: daí o suppressHydrationWarning.
    <html lang="pt-BR" className={cn(inter.variable, fraunces.variable)} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
