import { menuAgentOf, type SalesRule } from "@dishdesk/shared";
import { z } from "zod";
import { topItems } from "../../menu/menu-stats.js";
import { findOpenCart, optionIdsOf } from "./cart-tools.js";
import { availableNow, defineTool, fromPriceCents, loadCatalog, type MenuAgentDeps, type MenuAgentSession, money } from "./context.js";

/**
 * Venda pela IA (E48): o sistema decide o que oferecer e quando; o modelo só escreve a oferta no tom do restaurante.
 * As regras vêm de Configurações → Pedidos pela IA. Cada oferta sai uma vez por atendimento (o id fica em
 * `automationState.salesOffers`) e todas contam no limite por conversa. Item esgotado, pausado ou fora do horário nunca
 * é oferecido.
 */

export type SalesMoment = "ON_ADD" | "AT_END";

export type SalesLine = { cartItemId: string; itemId: string; optionIds: string[] };

export type SalesItem = {
  id: string;
  name: string;
  categoryId: string;
  available: boolean;
  fromCents: number | null;
  groups: { id: string; name: string; optionIds: string[]; options: { id: string; name: string; priceCents: number }[] }[];
  pairsWith: string[];
};

export type SalesOffer = {
  regraId: string;
  motivo: string;
  itens: { itemId: string; nome: string; precoAPartirDe: ReturnType<typeof money> | null }[];
  complementos: {
    cartItemId: string;
    item: string;
    grupo: string;
    opcoes: { complementoId: string; nome: string; preco: ReturnType<typeof money> }[];
    /** Os complementos que a linha já tem: o `alterar_item_carrinho` troca a lista inteira. */
    complementoIdsAtuais: string[];
  }[];
  argumento?: string;
};

export type SalesInput = {
  moment: SalesMoment;
  rules: SalesRule[];
  usePairings: boolean;
  lines: SalesLine[];
  items: Map<string, SalesItem>;
  categories: Map<string, string>;
  /** Ids dos mais vendidos de uma categoria, do maior para o menor (só para as regras do fim sem itens escolhidos). */
  topOf: (categoryId: string) => string[];
};

const OFFER_ITEMS_MAX = 3;

/** As ofertas que valem agora, na ordem: as regras do restaurante e, depois, o "Combina com" (só ao pedir). */
export function salesOffersFor({ moment, rules, usePairings, lines, items, categories, topOf }: SalesInput): SalesOffer[] {
  if (!lines.length) return [];
  const inCart = new Set(lines.map((line) => line.itemId));
  const categoryOf = (line: SalesLine) => items.get(line.itemId)?.categoryId;
  const sellable = (ids: string[]) =>
    ids
      .map((id) => items.get(id))
      .filter((item): item is SalesItem => !!item && item.available && !inCart.has(item.id))
      .slice(0, OFFER_ITEMS_MAX)
      .map((item) => ({ itemId: item.id, nome: item.name, precoAPartirDe: item.fromCents == null ? null : money(item.fromCents) }));
  const offers: SalesOffer[] = [];

  for (const rule of rules) {
    const category = categories.get(rule.categoryId);
    if (!category || rule.trigger !== moment) continue;
    const pitch = rule.pitch ? { argumento: rule.pitch } : {};
    if (rule.trigger === "AT_END") {
      if (lines.some((line) => categoryOf(line) === rule.categoryId)) continue;
      const menuOrder = [...items.values()].filter((item) => item.categoryId === rule.categoryId).map((item) => item.id);
      const ids = rule.itemIds.length ? rule.itemIds : [...new Set([...topOf(rule.categoryId), ...menuOrder])].filter((id) => items.get(id)?.categoryId === rule.categoryId);
      const itens = sellable(ids);
      if (itens.length) offers.push({ regraId: rule.id, motivo: `o carrinho não tem nada de ${category}`, itens, complementos: [], ...pitch });
      continue;
    }
    const triggers = lines.filter((line) => categoryOf(line) === rule.categoryId);
    if (!triggers.length) continue;
    const complementos: SalesOffer["complementos"] = [];
    for (const groupId of rule.groupIds) {
      for (const line of triggers) {
        const item = items.get(line.itemId)!;
        const group = item.groups.find((g) => g.id === groupId);
        // A linha já tem uma opção do grupo (já é combo, já tem borda) ou o grupo está sem opção à venda.
        if (!group?.options.length || line.optionIds.some((id) => group.optionIds.includes(id))) continue;
        complementos.push({
          cartItemId: line.cartItemId,
          item: item.name,
          grupo: group.name,
          opcoes: group.options.map((o) => ({ complementoId: o.id, nome: o.name, preco: money(o.priceCents) })),
          complementoIdsAtuais: line.optionIds,
        });
        break;
      }
    }
    const itens = sellable(rule.itemIds);
    if (!itens.length && !complementos.length) continue;
    const names = [...new Set(triggers.map((line) => items.get(line.itemId)!.name))].join(", ");
    offers.push({ regraId: rule.id, motivo: `o cliente pediu ${names} (${category})`, itens, complementos, ...pitch });
  }

  if (moment === "ON_ADD" && usePairings) {
    // O "Combina com" vale nas categorias sem regra própria ao pedir (a regra do restaurante manda).
    const ruled = new Set(rules.filter((rule) => rule.trigger === "ON_ADD").map((rule) => rule.categoryId));
    for (const line of [...lines].reverse()) {
      const item = items.get(line.itemId);
      if (!item || ruled.has(item.categoryId)) continue;
      const itens = sellable(item.pairsWith);
      if (itens.length) offers.push({ regraId: `combina:${item.id}`, motivo: `combina com ${item.name}`, itens, complementos: [] });
    }
  }
  return offers;
}

/** Quantas ofertas o agente ainda pode fazer (0: Venda pela IA desligada ou limite atingido). */
export function salesRemaining(settings: unknown, done: string[]): number {
  const agent = menuAgentOf(settings);
  return agent.suggestAddons ? Math.max(0, agent.maxSuggestionsPerConversation - done.length) : 0;
}

const NOTHING = "Nada a oferecer agora: siga o atendimento sem oferecer outro item por conta própria.";

/**
 * `ofertas_de_venda`: devolve a próxima oferta (uma só) e já a marca como feita. `done` são as ofertas feitas neste
 * atendimento; `onOffered` recebe a nova, que quem chama grava no estado da conversa.
 */
export function salesTool(deps: MenuAgentDeps, session: MenuAgentSession, done: string[], onOffered: (id: string) => void) {
  const made = [...done];
  return defineTool({
    name: "ofertas_de_venda",
    description:
      'A oferta de venda que o restaurante quer agora, calculada pelo sistema. Chame com momento "depois_de_adicionar" logo depois de pôr um item no carrinho, e com "fim" quando o cliente disser que terminou de escolher (antes de perguntar entrega ou retirada). Faça só a oferta que voltar.',
    inputSchema: z.object({ momento: z.enum(["depois_de_adicionar", "fim"]) }),
    handler: (input, ctx) =>
      deps.db.withTenants({ tenantIds: [ctx.tenantId] }, async (tx) => {
        const [tenant, menu] = await Promise.all([
          tx.tenant.findUnique({ where: { id: ctx.tenantId }, select: { settings: true } }),
          tx.menu.findUnique({ where: { tenantId: ctx.tenantId }, select: { id: true, active: true } }),
        ]);
        if (!tenant || !menu?.active || salesRemaining(tenant.settings, made) === 0) return { ok: true, oferta: null, dica: NOTHING };
        const now = deps.now?.() ?? new Date();
        const agent = menuAgentOf(tenant.settings);
        const { categories, items: loaded, catalog } = await loadCatalog({ tx, tenantId: ctx.tenantId, now, settings: tenant.settings, menuId: menu.id });
        const cart = await findOpenCart(tx, ctx.tenantId, session);
        const lines = (cart?.items ?? []).map((row) => ({ cartItemId: row.id, itemId: row.itemId, optionIds: optionIdsOf(row.options) }));
        const pairings = agent.usePairings
          ? await tx.menuItemPairing.findMany({ where: { tenantId: ctx.tenantId, itemId: { in: lines.map((line) => line.itemId) } }, select: { itemId: true, pairedItemId: true } })
          : [];
        const items = new Map(
          loaded.map((item): [string, SalesItem] => [
            item.id,
            {
              id: item.id,
              name: item.name,
              categoryId: item.categoryId,
              available: availableNow(catalog, item.id),
              fromCents: fromPriceCents(item),
              groups: item.optionGroups.map(({ group }) => ({
                id: group.id,
                name: group.name,
                optionIds: group.options.map((o) => o.id),
                options: group.options.filter((o) => !o.soldOut).map((o) => ({ id: o.id, name: o.name, priceCents: o.priceCents })),
              })),
              pairsWith: pairings.filter((p) => p.itemId === item.id).map((p) => p.pairedItemId),
            },
          ]),
        );
        const moment: SalesMoment = input.momento === "fim" ? "AT_END" : "ON_ADD";
        const needsTop = moment === "AT_END" ? agent.salesRules.filter((rule) => rule.trigger === "AT_END" && !rule.itemIds.length) : [];
        const tops = new Map(
          await Promise.all(
            needsTop.map(async (rule) => [rule.categoryId, (await topItems(tx, { tenantId: ctx.tenantId, categoryId: rule.categoryId, now })).map((t) => t.itemId)] as const),
          ),
        );
        const offer = salesOffersFor({
          moment,
          rules: agent.salesRules,
          usePairings: agent.usePairings,
          lines,
          items,
          categories: new Map(categories.map((c) => [c.id, c.name])),
          topOf: (categoryId) => tops.get(categoryId) ?? [],
        }).find((candidate) => !made.includes(candidate.regraId));
        if (!offer) return { ok: true, oferta: null, dica: NOTHING };
        made.push(offer.regraId);
        onOffered(offer.regraId);
        return {
          ok: true,
          oferta: offer,
          dica: [
            "Ofereça só isto, numa frase curta no seu tom, com o preço que veio. O argumento é o mote do restaurante: use a ideia, sem copiar palavra por palavra.",
            offer.complementos.length ? "Complemento aceito: alterar_item_carrinho no cartItemId, com complementoIds = complementoIdsAtuais mais o escolhido." : "",
            offer.itens.length ? "Item aceito: adicionar_ao_carrinho." : "",
            moment === "AT_END" ? "Se o carrinho já tem algo equivalente (ex.: bebida dentro de um combo), não ofereça e siga." : "",
            "Se o cliente recusar, siga sem insistir.",
          ]
            .filter(Boolean)
            .join(" "),
        };
      }),
  });
}
