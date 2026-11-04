import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark } from "@/components/brand/logo-mark";
import { NotFoundLinks } from "@/components/not-found-links";

export const metadata: Metadata = { title: "Página não encontrada — Dish Desk" };

/** 404 do site e do painel: em português, com saídas para o site e para o teste grátis. */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-paper px-6 py-16 text-center">
      <Link href="/" className="flex items-center gap-2.5 text-ink">
        <LogoMark />
        <span className="font-heading text-[19px] font-semibold">Dish Desk</span>
      </Link>
      <p className="text-sm font-semibold text-tomate tabular-nums">Erro 404</p>
      <h1 className="m-0 font-heading text-[clamp(32px,5vw,48px)] leading-tight font-bold tracking-tight text-ink">
        Página não encontrada
      </h1>
      <p className="m-0 max-w-md text-[15px] text-ink-2">O endereço pode estar errado ou a página mudou de lugar.</p>
      <NotFoundLinks />
    </main>
  );
}
