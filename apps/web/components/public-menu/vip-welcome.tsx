"use client";

import { CrownIcon, GiftIcon, TicketPercentIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { couponSummary, useCoupons } from "@/lib/coupons";
import { takeJustLoggedIn } from "@/lib/public-checkout";
import { money } from "@/lib/public-menu";
import { cn } from "@/lib/utils";
import { Sheet } from "./sheet";

const MONTH = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "America/Sao_Paulo" });

/** Um símbolo por uso: os já usados ficam cinzas e riscados. */
function Uses({ total, used, icon: Icon, label }: { total: number; used: number; icon: typeof GiftIcon; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="img" aria-label={`${total - used} de ${total} ${label} disponíveis`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "flex size-9 items-center justify-center rounded-lg border",
            i < used ? "border-rule bg-surface-2 text-ink-3 opacity-60" : "border-(--menu-accent)/40 bg-surface text-(--menu-accent)",
          )}
        >
          <Icon className="size-5" aria-hidden />
        </span>
      ))}
      <span className="ml-1 text-[12.5px] text-ink-2 tabular-nums">
        {total - used} de {total} {total - used === 1 ? "disponível" : "disponíveis"}
      </span>
    </div>
  );
}

/**
 * Boas-vindas do VIP: abre uma vez, logo depois do login pelo código, com as vantagens do mês. Cupom e brinde com
 * limite mostram um símbolo por uso (os usados em cinza); sem limite, só o texto.
 */
export function VipWelcome({ slug }: { slug: string }) {
  const [pending, setPending] = useState(false);
  const [closed, setClosed] = useState(false);
  const data = useCoupons(slug);
  // A marca é apagada ao ler: com o efeito rodando duas vezes (modo estrito), só a primeira abre.
  useEffect(() => {
    if (takeJustLoggedIn(slug)) queueMicrotask(() => setPending(true));
  }, [slug]);

  const coupon = data?.coupons.find((c) => c.id === "VIP") ?? null;
  const gift = data?.vipGift ?? null;
  if (!pending || closed || !data?.vip || (!coupon && !gift)) return null;

  const first = data.name?.split(/\s+/)[0];
  const minText = (cents: number) => (cents > 0 ? ` em pedidos a partir de ${money(cents)}` : "");
  return (
    <Sheet title="Cliente VIP" onClose={() => setClosed(true)}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-(--menu-accent)/10 text-(--menu-accent)">
            <CrownIcon className="size-7" aria-hidden />
          </span>
          <p className="m-0 font-heading text-[22px] font-semibold">Você é nosso cliente VIP!</p>
          <p className="m-0 text-ink-2">
            {first ? `${first}, estas` : "Estas"} são as suas vantagens em {MONTH.format(new Date())}:
          </p>
        </div>

        {coupon && (
          <section className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-3.5">
            <p className="m-0 font-semibold">Cupom {coupon.title}</p>
            <p className="m-0 text-[13px] text-ink-2">
              {couponSummary(coupon, money)}
              {minText(coupon.minOrderCents)}.
            </p>
            {coupon.frequency === "EVERY_ORDER" ? (
              <p className="m-0 text-[12.5px] text-ink-2">Vale em todo pedido.</p>
            ) : (
              <Uses total={1} used={coupon.available ? 0 : 1} icon={TicketPercentIcon} label="cupons" />
            )}
            {coupon.frequency === "ONCE" && <p className="m-0 text-[12px] text-ink-3">Vale uma vez só.</p>}
          </section>
        )}

        {gift && (
          <section className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-3.5">
            <p className="m-0 font-semibold">Brinde: {gift.name}</p>
            <p className="m-0 text-[13px] text-ink-2">De graça no seu carrinho{minText(gift.minOrderCents)}.</p>
            {gift.perMonth == null ? (
              <p className="m-0 text-[12.5px] text-ink-2">Vale em todo pedido.</p>
            ) : (
              <Uses total={gift.perMonth} used={Math.min(gift.usedThisMonth, gift.perMonth)} icon={GiftIcon} label="presentes" />
            )}
          </section>
        )}

        <button type="button" onClick={() => setClosed(true)} className="h-11 rounded-lg bg-ink font-medium text-paper">
          Ver o cardápio
        </button>
      </div>
    </Sheet>
  );
}
