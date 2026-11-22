import { z } from "zod";
import type { IfoodClient } from "../connectors/ifood.client.js";
import type { ImportRow } from "./menu-import.js";

// Importação do cardápio do iFood pela Catalog API v2 (exige o módulo Catalog no app do Dish Desk e a loja autorizando).
// Converte categorias e itens no mesmo formato de linhas da importação por CSV, que faz a revisão e grava.
// Formato conferido pela documentação do iFood (developer.ifood.com.br, guia do Catalog v2); validar com uma loja real
// quando o módulo for liberado.

const Money = z.looseObject({ value: z.coerce.number() });

const Option = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  status: z.string().optional(),
  price: Money.nullish(),
});

const OptionGroup = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  min: z.coerce.number().optional(),
  max: z.coerce.number().optional(),
  options: z.array(Option).default([]),
});

const Item = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().nullish(),
  status: z.string().optional(),
  sequence: z.coerce.number().optional(),
  price: Money.nullish(),
  optionGroups: z.array(OptionGroup).nullish(),
});

const PizzaSize = z.looseObject({ id: z.string(), name: z.string(), sequence: z.coerce.number().optional() });
const PizzaTopping = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().nullish(),
  status: z.string().optional(),
  // Preço do sabor por tamanho: { [sizeId]: valor }.
  prices: z.record(z.string(), z.coerce.number()).nullish(),
});

const Category = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  status: z.string().optional(),
  sequence: z.coerce.number().optional(),
  template: z.string().optional(),
  items: z.array(Item).nullish(),
  pizza: z
    .looseObject({
      sizes: z.array(PizzaSize).default([]),
      toppings: z.array(PizzaTopping).default([]),
    })
    .nullish(),
});
export type IfoodCatalogCategory = z.infer<typeof Category>;

const Catalog = z.looseObject({
  catalogId: z.string(),
  context: z.array(z.string()).default([]),
  status: z.string().optional(),
});

/** O catálogo de delivery da loja (contexto DEFAULT) com as categorias e os itens. */
export async function fetchIfoodCatalog(client: IfoodClient, merchantId: string): Promise<IfoodCatalogCategory[]> {
  const merchant = encodeURIComponent(merchantId);
  const catalogs = z.array(Catalog).parse(await client.get(`/catalog/v2.0/merchants/${merchant}/catalogs`));
  const catalog = catalogs.find((c) => c.context.includes("DEFAULT")) ?? catalogs[0];
  if (!catalog) return [];
  const categories = await client.get(`/catalog/v2.0/merchants/${merchant}/catalogs/${encodeURIComponent(catalog.catalogId)}/categories?includeItems=true`);
  return z.array(Category).parse(categories ?? []);
}

export type IfoodImport = { rows: ImportRow[]; warnings: string[] };

const SIZE_GROUP = /^(tamanhos?|escolha o tamanho|size)\b/i;
const cents = (value: number | undefined | null) => (value == null ? null : Math.round(value * 100));
const bySequence = <T extends { sequence?: number }>(list: T[]) => [...list].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

/**
 * Categorias do iFood -> linhas da importação. Tamanho vira tamanho do item (grupo "Tamanho" de escolha única);
 * categoria de pizza (template PIZZA) vira um item por sabor, com os tamanhos dela. Os demais grupos de complementos
 * ainda não entram (a importação não cria complementos) e aparecem nos avisos.
 */
export function ifoodCatalogToRows(categories: IfoodCatalogCategory[]): IfoodImport {
  const rows: ImportRow[] = [];
  const skippedGroups = new Set<string>();
  let line = 1;
  const push = (row: Omit<ImportRow, "line" | "errors" | "ingredients" | "allergens" | "servesPeople" | "tags" | "synonyms">) =>
    rows.push({ line: line++, ingredients: [], allergens: [], servesPeople: null, tags: [], synonyms: [], errors: [], ...row });

  for (const category of bySequence(categories)) {
    const name = category.name.trim();
    if (category.pizza && category.pizza.toppings.length) {
      const sizes = bySequence(category.pizza.sizes);
      for (const topping of category.pizza.toppings) {
        const priced = sizes.filter((size) => topping.prices?.[size.id] != null);
        if (!priced.length) continue;
        for (const size of priced) {
          push({ category: name, item: topping.name.trim(), description: topping.description?.trim() || null, priceCents: null, size: size.name.trim(), sizePriceCents: cents(topping.prices?.[size.id]) });
        }
      }
      continue;
    }
    for (const item of bySequence(category.items ?? [])) {
      const base = item.price?.value ?? 0;
      const groups = item.optionGroups ?? [];
      const sizeGroup = groups.find((group) => SIZE_GROUP.test(group.name.trim()) && (group.max ?? 1) === 1 && group.options.length > 0);
      for (const group of groups) if (group !== sizeGroup) skippedGroups.add(group.name.trim());
      const description = item.description?.trim() || null;
      if (sizeGroup) {
        for (const option of sizeGroup.options) {
          push({ category: name, item: item.name.trim(), description, priceCents: null, size: option.name.trim(), sizePriceCents: cents(base + (option.price?.value ?? 0)) });
        }
      } else {
        push({ category: name, item: item.name.trim(), description, priceCents: cents(base), size: null, sizePriceCents: null });
      }
    }
  }
  const warnings: string[] = [];
  if (skippedGroups.size) {
    warnings.push(`Grupos de complementos não importados (cadastre à mão em Complementos): ${[...skippedGroups].slice(0, 20).join(", ")}${skippedGroups.size > 20 ? "…" : ""}.`);
  }
  if (!rows.length) warnings.push("O iFood não devolveu itens com preço para esta loja.");
  return { rows, warnings };
}
