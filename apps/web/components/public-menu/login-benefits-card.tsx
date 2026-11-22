"use client";

import { ChevronRightIcon, TicketPercentIcon } from "lucide-react";
import { couponSummary, useCoupons } from "@/lib/coupons";
import { money } from "@/lib/public-menu";

/**
 * No lugar do "Calcular taxa": convida a entrar com o código para ver cupons e vantagens. Com o código, mostra os cupons
 * das tags positivas do cliente (as negativas nunca aparecem). O cliente escolhe o cupom na sacola.
 */
export function LoginBenefitsCard({ slug }: { slug: string }) {
  const data = useCoupons(slug);
  const login = `/c/${encodeURIComponent(slug)}/conta?voltar=1`;

  if (data === undefined) return <div className="h-[72px] animate-pulse rounded-xl bg-surface-2" aria-busy aria-label="Carregando" />;

  if (data === null) {
    return (
      <a href={login} className="flex items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3.5 text-ink no-underline">
        <TicketPercentIcon className="size-6 shrink-0 text-(--menu-accent)" aria-hidden />
        <span className="flex-1">
          <span className="block font-semibold">Faça o login para ver cupons e vantagens</span>
          <span className="block text-[12.5px] text-ink-2">Entre com o código que chega no seu WhatsApp.</span>
        </span>
        <ChevronRightIcon className="size-4 text-ink-2" aria-hidden />
      </a>
    );
  }

  const available = data.coupons.filter((c) => c.available);
  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-3.5">
      <p className="m-0 font-semibold">{data.name ? `Olá, ${data.name.split(/\s+/)[0]}!` : "Olá!"}</p>
      {data.coupons.length === 0 ? (
        <p className="m-0 text-[12.5px] text-ink-2">Você ainda não tem cupons. Os pedidos que você faz por aqui contam para as vantagens da casa.</p>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
          {data.coupons.map((coupon) => (
            <li key={coupon.id} className="flex items-center gap-2 rounded-lg border border-dashed border-(--menu-accent)/40 px-3 py-2">
              <TicketPercentIcon className="size-4 shrink-0 text-(--menu-accent)" aria-hidden />
              <span className="flex-1 text-[13px]">
                <span className="font-semibold">{coupon.title}</span> · {couponSummary(coupon, money)}
                {!coupon.available && coupon.reason && <span className="block text-[12px] text-ink-3">{coupon.reason}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && <p className="m-0 mt-2 text-[12px] text-ink-3">Escolha o cupom na sacola, antes de fechar o pedido.</p>}
    </div>
  );
}
