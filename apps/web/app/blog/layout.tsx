import Script from "next/script";
import type { ReactNode } from "react";
import { BlogFooter, BlogHeader } from "@/components/blog/site-chrome";

/** Blog do site institucional: sempre claro, com o topo e o rodapé do site e a mesma medição de tráfego. */
export default function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <div className="theme-light flex min-h-dvh flex-col bg-paper text-ink">
      <BlogHeader />
      <div className="flex-1">{children}</div>
      <BlogFooter />
      <Script src="/assets/track.js" strategy="afterInteractive" />
      <Script src="/assets/ads.js" strategy="afterInteractive" />
    </div>
  );
}
