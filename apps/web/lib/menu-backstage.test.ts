import { DEFAULT_MENU_STORE } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { changePct, choicePricesText, couponStatusView, discountText, reportCsv, validityText } from "@/lib/menu-backstage";
import { formToPayload, storeToForm } from "@/lib/menu-store";

const nbsp = (text: string) => text.replace(/ /g, " ");

describe("abas novas do Cardápio: textos de tela", () => {
  it("opção: o preço de venda em cada grupo", () => {
    const options = [
      { id: "1", priceCents: 800, group: { id: "g", name: "Borda da pizza G" } },
      { id: "2", priceCents: 600, group: { id: "m", name: "Borda da pizza M" } },
    ];
    expect(nbsp(choicePricesText({ options })!)).toBe('Esta opção custa R$ 8,00 em "Borda da pizza G" e R$ 6,00 em "Borda da pizza M".');
    expect(choicePricesText({ options: [] })).toBeNull();
  });

  it("cupom: desconto e validade como na lista", () => {
    expect(nbsp(discountText({ kind: "PERCENT", valueCents: 0, percent: 10, maxDiscountCents: 2000, minOrderCents: 0 }))).toBe("10% · máx. R$ 20");
    expect(nbsp(discountText({ kind: "PERCENT", valueCents: 0, percent: 20, maxDiscountCents: null, minOrderCents: 6000 }))).toBe("20% · pedido mín. R$ 60");
    expect(discountText({ kind: "FREE_DELIVERY", valueCents: 0, percent: 0, maxDiscountCents: null, minOrderCents: 0 })).toBe("Entrega grátis");
    expect(validityText({ startsOn: "2026-11-01", endsOn: "2026-12-31", weekdays: [1, 2, 3, 4], startMinute: 1080, endMinute: 1200 })).toBe("01/11 a 31/12 · seg a qui, 18h–20h");
    expect(validityText({ startsOn: null, endsOn: null, weekdays: [], startMinute: null, endMinute: null })).toBe("Sem data para acabar");
    expect(validityText({ startsOn: null, endsOn: "2026-11-30", weekdays: [], startMinute: null, endMinute: null })).toBe("até 30/11");
  });

  it("cupom: situação com o texto de apoio", () => {
    expect(couponStatusView({ kind: "AVAILABLE", until: "2026-11-26T23:00:00.000Z" })).toEqual({ label: "Disponível", tone: "success", sub: "até 20h" });
    expect(couponStatusView({ kind: "EXPIRED", reason: "DATE", since: "2026-07-10" })).toMatchObject({ label: "Expirado", sub: "terminou em 10/07" });
    expect(couponStatusView({ kind: "INACTIVE" })).toMatchObject({ label: "Inativo", sub: null });
  });

  it("relatório: variação e CSV em português", () => {
    expect(changePct(421_280, 376_140)).toBe(12);
    expect(changePct(100, 0)).toBeNull();
    const csv = reportCsv([{ id: "1", name: 'Pizza "G"', quantity: 2, revenueCents: 11_380, costCents: null, averageCents: 5_690, marginPct: null }], "Item");
    expect(csv.split("\n")).toEqual(["Item;Quantidade;Faturamento;Preço médio;Custo total;Margem (%)", '"Pizza ""G""";2;113,80;56,90;;']);
  });

  it("Cardápio e entrega mantém as áreas desenhadas ao salvar", () => {
    const base = { ...DEFAULT_MENU_STORE, delivery: { mode: "BY_AREA" as const, areas: [{ id: "a", name: "Até 2 km", shape: { type: "circle" as const, minKm: 0, maxKm: 2 }, feeCents: 500 }] } };
    const form = storeToForm(base, "#8E2F1B");
    expect(form.mode).toBe("BY_AREA");
    const result = formToPayload(form, base);
    expect(result.ok && result.body.delivery).toEqual(base.delivery);
  });
});
