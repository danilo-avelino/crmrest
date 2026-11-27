"use client";

import { HouseIcon, ShoppingBagIcon, UserIcon } from "lucide-react";

/** Barra inferior do celular (formato do Cardápio Web): Início, Pedidos e Perfil. */
export function BottomNav({ slug }: { slug: string }) {
  const account = `/c/${encodeURIComponent(slug)}/conta`;
  const item = "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-ink-3";
  return (
    <nav aria-label="Navegação da loja" className="fixed inset-x-0 bottom-0 z-40 flex h-[60px] border-t border-rule bg-surface lg:hidden">
      <button type="button" className={`${item} text-ink`} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
        <HouseIcon className="size-5 text-(--menu-accent)" aria-hidden />
        Início
      </button>
      <a href={account} className={item}>
        <ShoppingBagIcon className="size-5" aria-hidden />
        Pedidos
      </a>
      <a href={account} className={item}>
        <UserIcon className="size-5" aria-hidden />
        Perfil
      </a>
    </nav>
  );
}
