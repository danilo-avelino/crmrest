"use client";

import { ChevronRightIcon, MapPinIcon } from "lucide-react";
import { useState } from "react";
import { fetchQuote } from "@/lib/public-checkout";
import { moneyShort, type PublicMenuStore } from "@/lib/public-menu";
import { Sheet } from "./sheet";

/**
 * "Calcular taxa e tempo de entrega" (formato do Cardápio Web): abre a consulta pelo bairro e mostra, embaixo, a regra
 * de entrega grátis (R11: a regra aparece antes do cliente se comprometer).
 */
export function DeliveryCard({ slug, store }: { slug: string; store: PublicMenuStore }) {
  const [open, setOpen] = useState(false);
  const [district, setDistrict] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const calculate = async () => {
    if (!district.trim() || busy) return;
    setBusy(true);
    try {
      const quote = await fetchQuote(slug, { mode: "DELIVERY", subtotalCents: 0, address: { district: district.trim() } });
      setResult(
        quote.ok
          ? `${quote.feeCents === 0 ? "Entrega grátis" : `Taxa de ${moneyShort(quote.feeCents)}`} · ${quote.eta.minMinutes}–${quote.eta.maxMinutes} min`
          : quote.message,
      );
    } catch {
      setResult("Não conseguimos calcular agora. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-rule bg-surface">
      <button type="button" onClick={() => setOpen(true)} className="flex h-14 w-full items-center gap-3 px-4 text-left font-medium">
        <MapPinIcon className="size-[18px] shrink-0 text-ink-3" aria-hidden />
        <span className="flex-1">Calcular taxa e tempo de entrega</span>
        <ChevronRightIcon className="size-4 text-ink-2" aria-hidden />
      </button>
      {store.freeDeliveryFromCents != null && (
        <p className="m-0 border-t border-dashed border-rule px-4 py-2.5 text-center text-[12.5px] text-ink-2">
          <span className="font-semibold text-success-ink">Entrega grátis</span> em pedidos a partir de {moneyShort(store.freeDeliveryFromCents)}
        </p>
      )}
      {open && (
        <Sheet title="Taxa e tempo de entrega" onClose={() => setOpen(false)}>
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void calculate();
            }}
          >
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Seu bairro
              <input
                value={district}
                onChange={(event) => setDistrict(event.target.value)}
                placeholder="Ex.: Centro"
                className="h-11 rounded-lg border border-rule bg-surface px-3 text-[15px] outline-none focus:border-ink"
              />
            </label>
            <button type="submit" disabled={busy || !district.trim()} className="h-11 rounded-lg bg-(--menu-accent) font-semibold text-white disabled:opacity-55">
              {busy ? "Carregando…" : "Calcular"}
            </button>
            {result && (
              <p role="status" className="m-0 rounded-lg bg-surface-2 px-3 py-2.5 text-ink">
                {result}
              </p>
            )}
            {store.pickupEnabled && <p className="m-0 text-[12.5px] text-ink-3">Retirada no balcão sem taxa.</p>}
          </form>
        </Sheet>
      )}
    </div>
  );
}
