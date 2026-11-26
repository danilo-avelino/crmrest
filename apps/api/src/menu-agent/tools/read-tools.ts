import { businessHoursOf, dayHoursLabel, effectivePaymentMethods, closedAt, menuStoreOf, pausedOf, reopeningAt } from "@dishdesk/shared";
import { z } from "zod";
import { type DeliveryAddress, feeRangeOf, quoteDelivery, scheduleSlots } from "../../menu/delivery.js";
import { availableAt, effectivePrice, type LoadedMenuItem } from "../../menu/menu-catalog.js";
import { topItems } from "../../menu/menu-stats.js";
import { type Catalog, defineTool, fromPriceCents, Id, loadCatalog, type Loaded, type MenuAgentDeps, money, refuse, withMenu } from "./context.js";
import { normalizeText, type RecommendCandidate, recommend } from "./recommend.js";

/**
 * Ferramentas de leitura do agente de pedidos (F4-01). Nenhuma muda dado. O restaurante é sempre o `ctx.tenantId`
 * da conversa; um `tenantId` no input do modelo é descartado pelo schema e nunca lido.
 */

/** Limiar do word_similarity (pg_trgm), afinado no teste: "calab", "calabreza" e "linguiça" acham a calabresa. */
export const SEARCH_THRESHOLD = 0.45;

const HALF_RULE_TEXT = {
  MAX: "meio a meio cobra o preço do sabor mais caro",
  AVERAGE: "meio a meio cobra a média dos dois sabores",
  SUM: "meio a meio cobra a soma dos preços cheios dos dois sabores",
} as const;

/** Tags que o restaurante usa para destacar um item. */
const HIGHLIGHT_TAGS = ["mais pedido", "destaque", "mais vendido", "recomendado"];

const brief = (item: LoadedMenuItem, catalog: Catalog["catalog"], categoryName: string | undefined) => {
  const from = fromPriceCents(item);
  const priced = catalog.items instanceof Map ? catalog.items.get(item.id) : undefined;
  return {
    itemId: item.id,
    nome: item.name,
    categoria: categoryName ?? null,
    precoAPartirDe: from == null ? null : money(from),
    temTamanhos: item.sizes.length > 0,
    disponivel: !!priced && priced.active && !priced.soldOut,
    ...(item.soldOut ? { esgotado: true } : {}),
    ...(item.servesPeople ? { servePessoas: item.servesPeople } : {}),
    ...(item.tags.length ? { tags: item.tags } : {}),
  };
};

/** Busca por trigramas no texto de busca do item (nome, sinônimos, ingredientes). Ids na ordem da relevância. */
async function searchIds({ tx, tenantId, menuId }: Loaded, term: string, limit: number): Promise<string[]> {
  const q = term.toLowerCase().trim();
  if (!q) return [];
  // SET LOCAL: vale só nesta transação.
  await tx.$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(SEARCH_THRESHOLD)}, true)`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT i.id
    FROM menu_items i
    JOIN menu_categories c ON c.id = i.category_id AND c.tenant_id = i.tenant_id
    WHERE i.tenant_id = ${tenantId}::uuid AND c.menu_id = ${menuId}::uuid AND i.active AND c.active
      AND ${q} <% app.menu_item_search_text(i.name, i.synonyms, i.ingredients)
    ORDER BY word_similarity(${q}, app.menu_item_search_text(i.name, i.synonyms, i.ingredients)) DESC,
             similarity(${q}, lower(i.name)) DESC, i.sort_order ASC
    LIMIT ${limit}`;
  return rows.map((row) => row.id);
}

const AddressInput = z.object({
  rua: z.string().max(120).optional(),
  numero: z.string().max(20).optional(),
  bairro: z.string().max(80).optional(),
  cidade: z.string().max(80).optional(),
  cep: z.string().max(9).optional(),
});
export const Location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/** Dica para o modelo quando a cotação falha. */
export function quoteHint(code: string, byDistrict: boolean): string {
  if (code === "ADDRESS_REQUIRED")
    return byDistrict ? "Pergunte o bairro do cliente (só o CEP não basta)." : "Peça a localização do WhatsApp ou o endereço completo.";
  if (code === "OUT_OF_AREA") return "O endereço está fora da área: ofereça a retirada, se a loja aceitar.";
  if (code === "PICKUP_DISABLED") return "A loja não faz retirada: só entrega.";
  return "A loja ainda não configurou a área de entrega: chame a equipe.";
}

/** Subtotal do carrinho em montagem da conversa (0 sem carrinho), para a cotação da entrega. */
export type SubtotalOf = (loaded: Loaded, catalog: Catalog["catalog"]) => Promise<number>;

export function readTools(deps: MenuAgentDeps, subtotalOf: SubtotalOf) {
  const buscar_cardapio = defineTool({
    name: "buscar_cardapio",
    description:
      "Busca itens do cardápio pelo que o cliente escreveu (tolera erro de escrita, sinônimo e ingrediente). Sem termo, lista as categorias com os itens. Devolve ids para as outras ferramentas.",
    inputSchema: z.object({
      termo: z.string().max(80).optional().describe("O que o cliente pediu, ex.: calabresa, coca, sem lactose"),
      limite: z.number().int().min(1).max(20).default(8),
    }),
    handler: (input, ctx) =>
      withMenu(deps, ctx, async (loaded) => {
        const { categories, items, catalog } = await loadCatalog(loaded);
        const categoryName = new Map(categories.map((c) => [c.id, c.name]));
        if (!input.termo?.trim()) {
          return {
            categorias: categories.map((c) => ({
              nome: c.name,
              disponivelAgora: availableAt(c.availabilities, loaded.now),
              itens: items.filter((i) => i.categoryId === c.id).map((i) => brief(i, catalog, undefined)),
            })),
          };
        }
        const ids = await searchIds(loaded, input.termo, input.limite);
        const byId = new Map(items.map((i) => [i.id, i]));
        const found = ids.map((id) => byId.get(id)).filter((i) => !!i);
        return { termo: input.termo, itens: found.map((i) => brief(i, catalog, categoryName.get(i.categoryId))), ...(found.length ? {} : { dica: "Nada parecido no cardápio: ofereça as categorias." }) };
      }),
  });

  const detalhar_item = defineTool({
    name: "detalhar_item",
    description:
      "Detalhes de um item: descrição, tamanhos e preços, complementos (com mínimo e máximo), meio a meio, alérgenos e combinações. `notaDoRestaurante` é orientação do restaurante para você (não do cliente): siga, sem ler para o cliente.",
    inputSchema: z.object({ itemId: Id }),
    handler: (input, ctx) =>
      withMenu(deps, ctx, async (loaded) => {
        const { categories, items, catalog } = await loadCatalog(loaded);
        const item = items.find((i) => i.id === input.itemId);
        if (!item) return refuse("ITEM_NOT_FOUND", "Item não encontrado: use buscar_cardapio para achar o id.");
        const category = categories.find((c) => c.id === item.categoryId)!;
        const extra = await loaded.tx.menuItem.findFirst({
          where: { id: item.id, tenantId: loaded.tenantId },
          select: { aiNotes: true, pairsWith: { select: { pairedItemId: true } } },
        });
        const halfOk = category.allowsHalf && item.allowsHalf;
        const pairs = (extra?.pairsWith ?? []).map((p) => items.find((i) => i.id === p.pairedItemId)).filter((i) => !!i);
        return {
          ...brief(item, catalog, category.name),
          descricao: item.description,
          ...(item.ingredients.length ? { ingredientes: item.ingredients } : {}),
          ...(item.allergens.length ? { alergenos: item.allergens } : {}),
          tamanhos: item.sizes.map((s) => ({ tamanhoId: s.id, nome: s.name, preco: money(s.priceCents) })),
          complementos: item.optionGroups.map(({ group }) => ({
            grupo: group.name,
            minimo: group.minSelect,
            maximo: group.maxSelect,
            opcoes: group.options.map((o) => ({ complementoId: o.id, nome: o.name, preco: money(o.priceCents), ...(o.soldOut ? { esgotado: true } : {}) })),
          })),
          meioAMeio: halfOk ? { permitido: true, regra: HALF_RULE_TEXT[category.halfPricing] } : { permitido: false },
          ...(pairs.length ? { combinaCom: pairs.map((p) => ({ itemId: p.id, nome: p.name })) } : {}),
          // Instrução do restaurante para a IA (não é do cliente): seguir, sem repetir ao cliente palavra por palavra.
          ...(extra?.aiNotes ? { notaDoRestaurante: extra.aiNotes } : {}),
        };
      }),
  });

  const mais_vendidos = defineTool({
    name: "mais_vendidos",
    description: "Os itens mais vendidos nos últimos 30 dias (ou, sem vendas, os destaques do restaurante).",
    inputSchema: z.object({ limite: z.number().int().min(1).max(10).default(5) }),
    handler: (input, ctx) =>
      withMenu(deps, ctx, async (loaded) => {
        const { categories, items, catalog } = await loadCatalog(loaded);
        const categoryName = new Map(categories.map((c) => [c.id, c.name]));
        const byId = new Map(items.map((i) => [i.id, i]));
        const top = await topItems(loaded.tx, { tenantId: loaded.tenantId, limit: 20, now: loaded.now });
        let ranked = top.map((t) => byId.get(t.itemId)).filter((i) => !!i);
        const fonte = ranked.length ? "vendas" : "destaques";
        if (!ranked.length) ranked = items.filter((i) => isHighlight(i, loaded.settings));
        return { fonte, itens: ranked.slice(0, input.limite).map((i) => brief(i, catalog, categoryName.get(i.categoryId))) };
      }),
  });

  const recomendar = defineTool({
    name: "recomendar",
    description:
      "Sugere o que pedir para um grupo: quantas pessoas, preferências (ex.: vegetariano, picante) e orçamento em reais. A conta é do sistema; repita os preços como vierem.",
    inputSchema: z.object({
      pessoas: z.number().int().min(1).max(50),
      preferencias: z.array(z.string().max(40)).max(5).optional(),
      orcamentoReais: z.number().positive().max(100_000).optional(),
    }),
    handler: (input, ctx) =>
      withMenu(deps, ctx, async (loaded) => {
        const { items, catalog } = await loadCatalog(loaded);
        const sales = new Map(
          (await topItems(loaded.tx, { tenantId: loaded.tenantId, limit: 50, now: loaded.now })).map((t) => [t.itemId, t.quantity]),
        );
        const candidates = items.flatMap((item): RecommendCandidate[] => {
          const priced = catalog.items instanceof Map ? catalog.items.get(item.id) : undefined;
          if (!priced?.active || priced.soldOut) return [];
          const size = item.sizes.length ? item.sizes.reduce((a, b) => (b.priceCents > a.priceCents ? b : a)) : null;
          const unitCents = size?.priceCents ?? effectivePrice(item);
          if (unitCents == null) return [];
          return [
            {
              itemId: item.id,
              name: item.name,
              sizeId: size?.id ?? null,
              sizeName: size?.name ?? null,
              unitCents,
              servesPeople: item.servesPeople,
              keywords: normalizeText([item.name, ...item.tags, ...item.ingredients].join(" ")),
              popularity: (sales.get(item.id) ?? 0) + (isHighlight(item, loaded.settings) ? 5 : 0),
            },
          ];
        });
        const result = recommend(candidates, {
          people: input.pessoas,
          preferences: input.preferencias,
          budgetCents: input.orcamentoReais == null ? undefined : Math.round(input.orcamentoReais * 100),
        });
        const line = (c: RecommendCandidate) => ({
          itemId: c.itemId,
          nome: c.name,
          ...(c.sizeId ? { tamanhoId: c.sizeId, tamanho: c.sizeName } : {}),
          ...(c.servesPeople ? { servePessoas: c.servesPeople } : {}),
          precoUnitario: money(c.unitCents),
        });
        return {
          pessoas: input.pessoas,
          sugestao: result.lines.map(({ candidate, quantity }) => ({ ...line(candidate), quantidade: quantity })),
          servePessoas: result.servedPeople,
          total: money(result.totalCents),
          cobreTodos: result.coversEveryone,
          ...(result.preferencesMet === false ? { aviso: "Nenhum item atende às preferências: a sugestão as ignora." } : {}),
          ...(!result.coversEveryone && input.orcamentoReais != null ? { avisoOrcamento: "O orçamento não cobre todo mundo." } : {}),
          alternativas: result.alternatives.map(line),
          observacao: "Sem complementos. Confira opções obrigatórias com detalhar_item antes de adicionar.",
        };
      }),
  });

  const verificar_funcionamento = defineTool({
    name: "verificar_funcionamento",
    description: "Se a loja está aberta agora, quando abre, horário de hoje, agendamento, pedido mínimo, taxas, prazo e formas de pagamento.",
    inputSchema: z.object({}),
    handler: (_input, ctx) =>
      withMenu(deps, ctx, async ({ settings, now }) => {
        const store = menuStoreOf(settings);
        const hours = businessHoursOf(settings);
        const paused = pausedOf(settings);
        const closed = closedAt(hours, now);
        const status = paused ? "pausada" : closed ? "fechada" : "aberta";
        const slots = scheduleSlots(store, hours, now).slice(0, 4);
        const range = feeRangeOf(store);
        const weekday = new Date(now.getTime() - 3 * 3_600_000).getUTCDay();
        return {
          status,
          aberta: status === "aberta",
          ...(closed ? { abre: reopeningAt(hours, now) } : {}),
          horarioDeHoje: hours.enabled ? dayHoursLabel(hours.days[weekday] ?? []) : "sem horário definido",
          agendamento: store.scheduling.enabled
            ? { permitido: true, proximasFaixas: slots.map((s) => ({ inicio: s.start.toISOString(), faixa: s.label, dia: s.day === "today" ? "hoje" : "amanhã" })) }
            : { permitido: false },
          pedidoMinimo: money(store.minOrderCents),
          taxaDeEntrega: range ? { de: money(range.minCents), ate: money(range.maxCents) } : null,
          ...(store.freeDeliveryFromCents != null ? { freteGratisAPartirDe: money(store.freeDeliveryFromCents) } : {}),
          prazoEntregaMinutos: { min: store.deliveryMinMinutes, max: store.deliveryMaxMinutes },
          retirada: store.pickupEnabled ? { permitida: true, preparoMinutos: store.prepMinutes } : { permitida: false },
          formasDePagamento: effectivePaymentMethods(store),
        };
      }),
  });

  const calcular_entrega = defineTool({
    name: "calcular_entrega",
    description:
      "Calcula taxa e prazo da entrega (ou da retirada) para o carrinho atual. Aceita endereço (o bairro basta na entrega por bairro), CEP ou a localização do WhatsApp.",
    inputSchema: z.object({
      modo: z.enum(["entrega", "retirada"]).default("entrega"),
      endereco: AddressInput.optional(),
      cep: z.string().max(9).optional(),
      localizacao: Location.optional(),
    }),
    handler: (input, ctx) =>
      withMenu(deps, ctx, async (loaded) => {
        const store = menuStoreOf(loaded.settings);
        const { catalog } = await loadCatalog(loaded);
        const subtotalCents = await subtotalOf(loaded, catalog);
        const address: DeliveryAddress = { district: input.endereco?.bairro ?? null, lat: input.localizacao?.lat ?? null, lng: input.localizacao?.lng ?? null };
        const quote = quoteDelivery(store, { mode: input.modo === "retirada" ? "PICKUP" : "DELIVERY", subtotalCents, address });
        return formatQuote(quote, subtotalCents, store.delivery.mode === "BY_DISTRICT");
      }),
  });

  return [buscar_cardapio, detalhar_item, mais_vendidos, recomendar, verificar_funcionamento, calcular_entrega];
}

/** Destaque: tag do restaurante ou item da vitrine de promoções. */
function isHighlight(item: LoadedMenuItem, settings: unknown): boolean {
  const tags = item.tags.map(normalizeText);
  return HIGHLIGHT_TAGS.some((t) => tags.includes(t)) || menuStoreOf(settings).promoShowcase.itemIds.includes(item.id);
}

export function formatQuote(quote: ReturnType<typeof quoteDelivery>, subtotalCents: number, byDistrict: boolean) {
  if (!quote.ok) return refuse(quote.code, quoteHint(quote.code, byDistrict));
  return {
    ok: true as const,
    modo: quote.mode === "PICKUP" ? "retirada" : "entrega",
    subtotalDoCarrinho: money(subtotalCents),
    taxa: money(quote.feeCents),
    freteGratis: quote.freeDelivery,
    ...(quote.missingForFreeCents != null ? { faltaParaFreteGratis: money(quote.missingForFreeCents) } : {}),
    ...(quote.missingForMinimumCents > 0 ? { faltaParaPedidoMinimo: money(quote.missingForMinimumCents) } : {}),
    prazoMinutos: { min: quote.eta.minMinutes, max: quote.eta.maxMinutes },
  };
}
