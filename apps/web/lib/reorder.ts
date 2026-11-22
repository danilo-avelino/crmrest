// "Pedir de novo" (W15/W16): as escolhas guardadas no pedido viram linhas da sacola, com os nomes e preços do cardápio
// de agora. O preço é só uma estimativa: a sacola confere cada linha na API ao abrir (pricedAt 0) e o checkout de novo.

import type { CartLine } from "./public-cart";
import { newLineId } from "./public-cart";
import { orderable, type PublicMenuCategory, type PublicMenuItem } from "./public-menu";

export type ReorderSelection = { itemId: string; sizeId: string | null; optionIds: string[]; halves: string[]; quantity: number; note: string | null };

/** Linhas para a sacola e quantas escolhas ficaram de fora (item esgotado, fora do horário ou que saiu do cardápio). */
export function reorderLines(categories: PublicMenuCategory[], selections: ReorderSelection[]): { lines: CartLine[]; skipped: number } {
  const items = new Map<string, PublicMenuItem>(categories.flatMap((c) => c.items).map((item) => [item.id, item]));
  const lines: CartLine[] = [];
  let skipped = 0;
  for (const selection of selections) {
    const item = items.get(selection.itemId);
    const size = selection.sizeId ? item?.sizes.find((s) => s.id === selection.sizeId) : null;
    const half = selection.halves[0] ? items.get(selection.halves[0]) : null;
    const allOptions = new Map((item?.optionGroups ?? []).flatMap((g) => g.options).map((o) => [o.id, o]));
    const optionsOk = selection.optionIds.every((id) => allOptions.get(id) && !allOptions.get(id)!.soldOut);
    if (!item || !orderable(item) || (selection.sizeId && !size) || (selection.halves[0] && (!half || !orderable(half))) || !optionsOk) {
      skipped++;
      continue;
    }
    const options: Record<string, number> = {};
    for (const id of selection.optionIds) options[id] = (options[id] ?? 0) + 1;
    const optionLines = Object.keys(options).map((id) => ({ id, name: allOptions.get(id)!.name, priceCents: allOptions.get(id)!.priceCents }));
    const base = size?.priceCents ?? item.priceCents ?? 0;
    const unitCents = base + selection.optionIds.reduce((sum, id) => sum + allOptions.get(id)!.priceCents, 0);
    lines.push({
      id: newLineId(),
      itemId: item.id,
      name: item.name,
      sizeId: size?.id ?? null,
      sizeName: size?.name ?? null,
      half: half ? { id: half.id, name: half.name } : null,
      options,
      optionLines,
      quantity: selection.quantity,
      note: selection.note,
      unitCents,
      totalCents: unitCents * selection.quantity,
      pricedAt: 0,
    });
  }
  return { lines, skipped };
}
