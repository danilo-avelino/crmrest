"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** Saídas da página 404, com o estilo dos botões (o buttonVariants só roda no cliente). */
export function NotFoundLinks() {
  return (
    <nav aria-label="Para onde ir" className="flex flex-wrap justify-center gap-3">
      <Link href="/" className={buttonVariants({ variant: "default" })}>
        Ir para o início
      </Link>
      <Link href="/funcionalidades" className={buttonVariants({ variant: "outline" })}>
        Funcionalidades
      </Link>
      <Link href="/cadastro" className={buttonVariants({ variant: "accent" })}>
        Testar grátis
      </Link>
      <a
        href="https://wa.me/5586999731647?text=Ol%C3%A1!%20Quero%20conhecer%20o%20Dish%20Desk."
        className={buttonVariants({ variant: "outline" })}
      >
        Falar no WhatsApp
      </a>
    </nav>
  );
}
