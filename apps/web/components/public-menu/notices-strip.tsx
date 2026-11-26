"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicNotice } from "@/lib/public-menu";
import { cn } from "@/lib/utils";

/**
 * Avisos no topo do cardápio (aba Avisos, N5): faixas com imagem, uma por vez. Passam sozinhas a cada 5 segundos e o
 * cliente também pode arrastar (rolagem com encaixe). Com movimento reduzido no sistema, não passam sozinhas.
 */
export function NoticesStrip({ notices }: { notices: PublicNotice[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (notices.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      const el = track.current;
      if (!el) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % notices.length;
      el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [notices.length]);

  return (
    <section aria-label="Avisos da loja" className="pt-4">
      <div
        ref={track}
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
        className="flex snap-x snap-mandatory overflow-x-auto rounded-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {notices.map((notice) => (
          <article key={notice.id} className="w-full shrink-0 snap-start overflow-hidden rounded-xl border border-rule bg-surface">
            {notice.photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- imagem do restaurante vinda do armazenamento
              <img src={notice.photoUrl} alt="" className="h-40 w-full object-cover lg:h-56" />
            )}
            <div className="px-4 py-3">
              <h2 className="m-0 text-[16px] font-semibold">{notice.title}</h2>
              {notice.body && <p className="m-0 text-[13.5px] text-ink-2">{notice.body}</p>}
            </div>
          </article>
        ))}
      </div>
      {notices.length > 1 && (
        <div className="mt-2 flex justify-center gap-1" aria-hidden>
          {notices.map((n, i) => (
            <span key={n.id} className={cn("h-1.5 rounded-full transition-all", i === index ? "w-4 bg-ink" : "w-1.5 bg-rule")} />
          ))}
        </div>
      )}
    </section>
  );
}
