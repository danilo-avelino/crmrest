import type { TenantTx } from "@dishdesk/database";
import { businessHoursOf, effectivePaymentMethods, isOpenAt, menuStoreOf, pausedOf, reopeningAt } from "@dishdesk/shared";
import { z } from "zod";
import { feeRangeOf, quoteDelivery, scheduleSlots } from "../../menu/delivery.js";
import { type LineSelection, type PricedLine, type PricingError, priceLine } from "../../menu/pricing.js";
import { type Catalog, defineTool, Id, loadCatalog, type Loaded, type MenuAgentDeps, type MenuAgentSession, money, refuse, withMenu } from "./context.js";
import { formatQuote, Location, quoteHint } from "./read-tools.js";

/**
 * Ferramentas do carrinho do agente de pedidos (F4-02). Um carrinho aberto (DRAFT ou AWAITING_CONFIRMATION) por
 * conversa, criado no primeiro item. Toda conta é do `priceLine`/`quoteDelivery`; o modelo só repete o que volta.
 * Qualquer mudança depois do resumo devolve o carrinho a DRAFT: o cliente precisa ver o resumo de novo.
 */

const OPEN = ["DRAFT", "AWAITING_CONFIRMATION"] as const;

/** Dados de entrega guardados em `Cart.deliveryAddress`. */
export type CartDelivery = {
  mode: "DELIVERY" | "PICKUP";
  street?: string;
  number?: string;
  district?: string;
  city?: string;
  zip?: string;
  complement?: string;
  reference?: string;
  lat?: number;
  lng?: number;
  /** Início da faixa agendada (ISO). */
  scheduledFor?: string;
  scheduledLabel?: string;
};

type StoredOption = { id: string; groupId: string; name: string; priceCents: number };

const CART_INCLUDE = {
  items: {
    orderBy: { createdAt: "asc" },
    include: { item: { select: { name: true } }, size: { select: { name: true } } },
  },
} as const;

function findOpenCart(tx: TenantTx, tenantId: string, session: MenuAgentSession) {
  return tx.cart.findFirst({
    where: { tenantId, conversationId: session.conversationId, status: { in: [...OPEN] } },
    orderBy: { createdAt: "desc" },
    include: CART_INCLUDE,
  });
}
type OpenCart = NonNullable<Awaited<ReturnType<typeof findOpenCart>>>;

const optionIdsOf = (options: unknown) => (Array.isArray(options) ? (options as StoredOption[]).map((o) => o.id) : []);

const selectionOf = (row: OpenCart["items"][number]): LineSelection => ({
  itemId: row.itemId,
  sizeId: row.sizeId,
  optionIds: optionIdsOf(row.options),
  halves: row.halves,
  quantity: row.quantity,
});

/** Erro do preço com o que o modelo precisa para perguntar ao cliente (tamanhos, grupos, sabores). */
function pricingRefusal(errors: PricingError[], itemId: string, { items, categories }: Catalog) {
  const item = items.find((i) => i.id === itemId);
  const codes = new Set(errors.map((e) => e.code));
  const extra: Record<string, unknown> = { erros: errors.map((e) => ({ codigo: e.code, mensagem: e.message })) };
  const hints: string[] = [];
  if (item && (codes.has("SIZE_REQUIRED") || codes.has("SIZE_NOT_FOUND"))) {
    hints.push("Pergunte o tamanho ao cliente.");
    extra.tamanhos = item.sizes.map((s) => ({ tamanhoId: s.id, nome: s.name, preco: money(s.priceCents) }));
  }
  if (item && ["GROUP_MIN", "GROUP_MAX", "OPTION_NOT_FOUND", "OPTION_UNAVAILABLE"].some((c) => codes.has(c as PricingError["code"]))) {
    hints.push("Confira os complementos: respeite o mínimo e o máximo de cada grupo.");
    extra.complementos = item.optionGroups.map(({ group }) => ({
      grupo: group.name,
      minimo: group.minSelect,
      maximo: group.maxSelect,
      opcoes: group.options.filter((o) => !o.soldOut).map((o) => ({ complementoId: o.id, nome: o.name, preco: money(o.priceCents) })),
    }));
  }
  if (item && ["HALF_NOT_ALLOWED", "HALF_OTHER_CATEGORY", "HALF_SIZE_MISSING", "HALF_TOO_MANY"].some((c) => codes.has(c as PricingError["code"]))) {
    const category = categories.find((c) => c.id === item.categoryId);
    const flavors = category?.allowsHalf && item.allowsHalf ? items.filter((i) => i.categoryId === item.categoryId && i.id !== item.id && i.allowsHalf && !i.soldOut) : [];
    hints.push(flavors.length ? "Ofereça outro sabor da mesma categoria para a outra metade." : "Esse item não pode ser meio a meio.");
    if (flavors.length) extra.saboresPossiveis = flavors.map((f) => ({ itemId: f.id, nome: f.name }));
  }
  if (codes.has("ITEM_NOT_FOUND") || codes.has("ITEM_UNAVAILABLE")) hints.push("Item indisponível ou inexistente: ofereça outro (buscar_cardapio).");
  if (codes.has("INVALID_QUANTITY")) hints.push("A quantidade vai de 1 a 99.");
  return refuse(errors[0]!.code, hints.join(" ") || errors[0]!.message, extra);
}

/** Uma linha precificada como o modelo vê. */
function lineView(row: OpenCart["items"][number], priced: PricedLine, catalog: Catalog) {
  const half = priced.halves[0] ? catalog.items.find((i) => i.id === priced.halves[0]) : undefined;
  return {
    cartItemId: row.id,
    nome: row.item.name,
    ...(row.size ? { tamanho: row.size.name } : {}),
    ...(half ? { outraMetade: half.name } : {}),
    ...(priced.options.length ? { complementos: priced.options.map((o) => (o.priceCents ? `${o.name} (+${money(o.priceCents).texto})` : o.name)) } : {}),
    quantidade: priced.quantity,
    ...(row.notes ? { observacao: row.notes } : {}),
    precoUnitario: money(priced.unitCents),
    total: money(priced.totalCents),
  };
}

const deliveryOf = (cart: { deliveryAddress: unknown }): CartDelivery | null => {
  const value = cart.deliveryAddress as CartDelivery | null;
  return value && (value.mode === "DELIVERY" || value.mode === "PICKUP") ? value : null;
};

const addressText = (d: CartDelivery) =>
  [[d.street, d.number].filter(Boolean).join(", "), d.complement, d.district, d.city].filter(Boolean).join(" - ") ||
  (d.lat != null ? "localização enviada pelo WhatsApp" : "");

/** Carrinho recalculado: linhas válidas, linhas com problema, subtotal, entrega e total. */
function computeCart(loaded: Loaded, catalog: Catalog, cart: OpenCart | null) {
  const store = menuStoreOf(loaded.settings);
  const lines: ReturnType<typeof lineView>[] = [];
  const problems: { cartItemId: string; nome: string; problema: string }[] = [];
  let subtotalCents = 0;
  for (const row of cart?.items ?? []) {
    const priced = priceLine(catalog.catalog, selectionOf(row));
    if (priced.ok) {
      lines.push(lineView(row, priced.value, catalog));
      subtotalCents += priced.value.totalCents;
    } else problems.push({ cartItemId: row.id, nome: row.item.name, problema: priced.errors.map((e) => e.message).join(" ") });
  }
  const delivery = cart ? deliveryOf(cart) : null;
  const quote = delivery
    ? quoteDelivery(store, { mode: delivery.mode, subtotalCents, address: { district: delivery.district ?? null, lat: delivery.lat ?? null, lng: delivery.lng ?? null } })
    : null;
  const feeCents = quote?.ok ? quote.feeCents : 0;
  return { store, lines, problems, subtotalCents, delivery, quote, feeCents, totalCents: subtotalCents + feeCents };
}

function cartSummary(computed: ReturnType<typeof computeCart>, status: string) {
  const { store, lines, problems, subtotalCents, delivery, quote, totalCents } = computed;
  const range = feeRangeOf(store);
  return {
    status,
    itens: lines,
    ...(problems.length ? { itensComProblema: problems, dica: "Avise o cliente e remova ou troque esses itens." } : {}),
    subtotal: money(subtotalCents),
    entrega: delivery
      ? {
          modo: delivery.mode === "PICKUP" ? "retirada" : "entrega",
          ...(delivery.mode === "DELIVERY" ? { endereco: addressText(delivery) } : {}),
          ...(delivery.scheduledLabel ? { agendadoPara: delivery.scheduledLabel, agendadoInicio: delivery.scheduledFor } : {}),
          ...(quote ? formatQuote(quote, subtotalCents, store.delivery.mode === "BY_DISTRICT") : {}),
        }
      : {
          definida: false,
          ...(range ? { taxaDe: money(range.minCents), taxaAte: money(range.maxCents) } : {}),
          ...(store.freeDeliveryFromCents != null ? { freteGratisAPartirDe: money(store.freeDeliveryFromCents) } : {}),
        },
    total: money(totalCents),
    ...(store.minOrderCents > subtotalCents ? { faltaParaPedidoMinimo: money(store.minOrderCents - subtotalCents) } : {}),
  };
}

/** Subtotal do carrinho aberto da conversa (para o `calcular_entrega`). */
export function cartSubtotal(session: MenuAgentSession) {
  return async (loaded: Loaded, catalog: Catalog["catalog"]) => {
    const cart = await findOpenCart(loaded.tx, loaded.tenantId, session);
    let subtotal = 0;
    for (const row of cart?.items ?? []) {
      const priced = priceLine(catalog, selectionOf(row));
      if (priced.ok) subtotal += priced.value.totalCents;
    }
    return subtotal;
  };
}

const LineInput = {
  tamanhoId: Id.optional().describe("Obrigatório quando o item tem tamanhos"),
  complementoIds: z.array(Id).max(30).optional().describe("Um id por unidade de complemento"),
  outraMetadeId: Id.optional().describe("Item da outra metade (meio a meio, mesma categoria)"),
  observacao: z.string().max(200).optional(),
};

const DeliveryInput = z.object({
  modo: z.enum(["entrega", "retirada"]),
  endereco: z
    .object({
      rua: z.string().max(120).optional(),
      numero: z.string().max(20).optional(),
      bairro: z.string().max(80).optional(),
      cidade: z.string().max(80).optional(),
      cep: z.string().max(9).optional(),
      complemento: z.string().max(80).optional(),
      referencia: z.string().max(120).optional(),
    })
    .optional(),
  localizacao: Location.optional().describe("Localização enviada pelo WhatsApp"),
  enderecoSalvoId: Id.optional().describe("Endereço salvo do cliente (de ver_carrinho)"),
  agendarPara: z.string().max(40).optional().describe("Início de uma faixa de verificar_funcionamento (ISO)"),
});

export function cartTools(deps: MenuAgentDeps, session: MenuAgentSession) {
  /** Roda com o carrinho aberto; `create` abre um se não houver. */
  const withCart = <T>(
    ctx: { tenantId: string },
    create: boolean,
    fn: (loaded: Loaded, catalog: Catalog, cart: OpenCart | null) => Promise<T>,
  ) =>
    withMenu(deps, ctx, async (loaded) => {
      const catalog = await loadCatalog(loaded);
      let cart = await findOpenCart(loaded.tx, loaded.tenantId, session);
      if (!cart && create) {
        await loaded.tx.cart.create({
          data: { tenantId: loaded.tenantId, conversationId: session.conversationId, contactId: session.contactId },
          select: { id: true },
        });
        cart = await findOpenCart(loaded.tx, loaded.tenantId, session);
      }
      return fn(loaded, catalog, cart);
    });

  /** Depois de mudar o carrinho: volta a DRAFT e devolve a visão atualizada. */
  const afterChange = async (loaded: Loaded, catalog: Catalog, cartId: string) => {
    await loaded.tx.cart.update({ where: { id: cartId }, data: { status: "DRAFT" }, select: { id: true } });
    const cart = await findOpenCart(loaded.tx, loaded.tenantId, session);
    return { ok: true as const, carrinho: cartSummary(computeCart(loaded, catalog, cart), "DRAFT") };
  };

  const adicionar_ao_carrinho = defineTool({
    name: "adicionar_ao_carrinho",
    description: "Adiciona um item ao carrinho com tamanho, complementos e meio a meio. O sistema calcula o preço; escolha inválida volta com o que perguntar.",
    inputSchema: z.object({ itemId: Id, quantidade: z.number().int().default(1), ...LineInput }),
    handler: (input, ctx) =>
      withMenu(deps, ctx, async (loaded) => {
        const catalog = await loadCatalog(loaded);
        const selection: LineSelection = {
          itemId: input.itemId,
          sizeId: input.tamanhoId ?? null,
          optionIds: input.complementoIds ?? [],
          halves: input.outraMetadeId ? [input.outraMetadeId] : [],
          quantity: input.quantidade,
        };
        const priced = priceLine(catalog.catalog, selection);
        if (!priced.ok) return pricingRefusal(priced.errors, input.itemId, catalog);
        const cart = await findOpenCart(loaded.tx, loaded.tenantId, session);
        const cartId =
          cart?.id ??
          (
            await loaded.tx.cart.create({
              data: { tenantId: loaded.tenantId, conversationId: session.conversationId, contactId: session.contactId },
              select: { id: true },
            })
          ).id;
        await loaded.tx.cartItem.create({
          data: {
            tenantId: loaded.tenantId,
            cartId,
            itemId: priced.value.itemId,
            sizeId: priced.value.sizeId,
            halves: priced.value.halves,
            options: priced.value.options as StoredOption[],
            quantity: priced.value.quantity,
            notes: input.observacao ?? null,
          },
          select: { id: true },
        });
        return afterChange(loaded, catalog, cartId);
      }),
  });

  const alterar_item_carrinho = defineTool({
    name: "alterar_item_carrinho",
    description: "Muda quantidade, tamanho, complementos, outra metade ou observação de um item do carrinho. Campo omitido fica como está.",
    inputSchema: z.object({
      cartItemId: Id,
      quantidade: z.number().int().optional(),
      tamanhoId: Id.optional(),
      complementoIds: z.array(Id).max(30).optional(),
      outraMetadeId: Id.nullable().optional().describe("null tira o meio a meio"),
      observacao: z.string().max(200).nullable().optional(),
    }),
    handler: (input, ctx) =>
      withCart(ctx, false, async (loaded, catalog, cart) => {
        const row = cart?.items.find((i) => i.id === input.cartItemId);
        if (!cart || !row) return refuse("CART_ITEM_NOT_FOUND", "Item não está no carrinho: veja com ver_carrinho.");
        const current = selectionOf(row);
        const selection: LineSelection = {
          itemId: row.itemId,
          sizeId: input.tamanhoId ?? current.sizeId,
          optionIds: input.complementoIds ?? current.optionIds,
          halves: input.outraMetadeId === null ? [] : input.outraMetadeId ? [input.outraMetadeId] : current.halves,
          quantity: input.quantidade ?? current.quantity,
        };
        const priced = priceLine(catalog.catalog, selection);
        if (!priced.ok) return pricingRefusal(priced.errors, row.itemId, catalog);
        await loaded.tx.cartItem.update({
          where: { id: row.id },
          data: {
            sizeId: priced.value.sizeId,
            halves: priced.value.halves,
            options: priced.value.options as StoredOption[],
            quantity: priced.value.quantity,
            ...(input.observacao !== undefined ? { notes: input.observacao } : {}),
          },
          select: { id: true },
        });
        return afterChange(loaded, catalog, cart.id);
      }),
  });

  const remover_do_carrinho = defineTool({
    name: "remover_do_carrinho",
    description: "Tira um item do carrinho.",
    inputSchema: z.object({ cartItemId: Id }),
    handler: (input, ctx) =>
      withCart(ctx, false, async (loaded, catalog, cart) => {
        const row = cart?.items.find((i) => i.id === input.cartItemId);
        if (!cart || !row) return refuse("CART_ITEM_NOT_FOUND", "Item não está no carrinho: veja com ver_carrinho.");
        await loaded.tx.cartItem.delete({ where: { id: row.id }, select: { id: true } });
        return afterChange(loaded, catalog, cart.id);
      }),
  });

  const ver_carrinho = defineTool({
    name: "ver_carrinho",
    description: "Mostra o carrinho com preços recalculados, entrega, total e (sem entrega definida) os endereços salvos do cliente.",
    inputSchema: z.object({}),
    handler: (_input, ctx) =>
      withCart(ctx, false, async (loaded, catalog, cart) => {
        const computed = computeCart(loaded, catalog, cart);
        const saved =
          !computed.delivery && session.contactId
            ? await loaded.tx.contactAddress.findMany({
                where: { tenantId: loaded.tenantId, contactId: session.contactId },
                select: { id: true, label: true, street: true, number: true, district: true, city: true },
                take: 5,
              })
            : [];
        return {
          ...cartSummary(computed, cart?.status ?? "VAZIO"),
          ...(saved.length
            ? { enderecosSalvos: saved.map((a) => ({ enderecoSalvoId: a.id, rotulo: a.label, endereco: [[a.street, a.number].filter(Boolean).join(", "), a.district, a.city].filter(Boolean).join(" - ") })) }
            : {}),
        };
      }),
  });

  const definir_dados_entrega = defineTool({
    name: "definir_dados_entrega",
    description:
      "Define entrega ou retirada: endereço digitado, a localização do WhatsApp (lat/lng) ou um endereço salvo, e o agendamento opcional. Fora da área é recusado.",
    inputSchema: DeliveryInput,
    handler: (input, ctx) =>
      withCart(ctx, true, async (loaded, catalog, cart) => {
        const store = menuStoreOf(loaded.settings);
        const byDistrict = store.delivery.mode === "BY_DISTRICT";
        const data: CartDelivery = { mode: input.modo === "retirada" ? "PICKUP" : "DELIVERY" };
        if (data.mode === "DELIVERY") {
          if (input.enderecoSalvoId) {
            const saved = session.contactId
              ? await loaded.tx.contactAddress.findFirst({ where: { id: input.enderecoSalvoId, tenantId: loaded.tenantId, contactId: session.contactId } })
              : null;
            if (!saved) return refuse("ADDRESS_NOT_FOUND", "Endereço salvo não encontrado: peça o endereço ao cliente.");
            Object.assign(data, {
              street: saved.street,
              number: saved.number ?? undefined,
              district: saved.district ?? undefined,
              city: saved.city,
              zip: saved.zipCode ?? undefined,
              complement: saved.complement ?? undefined,
            });
          }
          const e = input.endereco;
          if (e) {
            for (const [key, value] of [
              ["street", e.rua],
              ["number", e.numero],
              ["district", e.bairro],
              ["city", e.cidade],
              ["zip", e.cep],
              ["complement", e.complemento],
              ["reference", e.referencia],
            ] as const)
              if (value?.trim()) data[key] = value.trim();
          }
          if (input.localizacao) Object.assign(data, input.localizacao);
        }
        const computed = computeCart(loaded, catalog, cart);
        const quote = quoteDelivery(store, {
          mode: data.mode,
          subtotalCents: computed.subtotalCents,
          address: { district: data.district ?? null, lat: data.lat ?? null, lng: data.lng ?? null },
        });
        if (!quote.ok) return refuse(quote.code, quoteHint(quote.code, byDistrict));
        if (data.mode === "DELIVERY" && !data.street && data.lat == null)
          return refuse("ADDRESS_REQUIRED", "Falta a rua e o número (ou a localização do WhatsApp) para o entregador.");
        if (input.agendarPara) {
          const wanted = Date.parse(input.agendarPara);
          const slot = scheduleSlots(store, businessHoursOf(loaded.settings), loaded.now).find((s) => s.start.getTime() === wanted);
          if (!slot)
            return refuse("SLOT_INVALIDO", store.scheduling.enabled ? "Use uma faixa de verificar_funcionamento." : "A loja não aceita agendamento.");
          data.scheduledFor = slot.start.toISOString();
          data.scheduledLabel = `${slot.day === "today" ? "hoje" : "amanhã"}, ${slot.label}`;
        }
        await loaded.tx.cart.update({ where: { id: cart!.id }, data: { deliveryAddress: data }, select: { id: true } });
        return afterChange(loaded, catalog, cart!.id);
      }),
  });

  const resumir_pedido = defineTool({
    name: "resumir_pedido",
    description:
      "Confere o carrinho e o deixa aguardando a confirmação do cliente. Devolve os dados do resumo (itens, subtotal, taxa, total, prazo ou horário agendado) ou o que falta.",
    inputSchema: z.object({}),
    handler: (_input, ctx) =>
      withCart(ctx, false, async (loaded, catalog, cart) => {
        if (!cart?.items.length) return refuse("CARRINHO_VAZIO", "O carrinho está vazio.");
        const computed = computeCart(loaded, catalog, cart);
        const { store, delivery, quote } = computed;
        const hours = businessHoursOf(loaded.settings);
        const pending: { codigo: string; dica: string }[] = [];
        if (computed.problems.length) pending.push({ codigo: "ITEM_COM_PROBLEMA", dica: "Remova ou troque os itens com problema." });
        if (!delivery) pending.push({ codigo: "DADOS_DE_ENTREGA", dica: "Pergunte entrega ou retirada e use definir_dados_entrega." });
        else if (quote && !quote.ok) pending.push({ codigo: quote.code, dica: quoteHint(quote.code, store.delivery.mode === "BY_DISTRICT") });
        if (store.minOrderCents > computed.subtotalCents)
          pending.push({ codigo: "PEDIDO_MINIMO", dica: `Faltam ${money(store.minOrderCents - computed.subtotalCents).texto} para o pedido mínimo.` });
        const scheduled = delivery?.scheduledFor ? new Date(delivery.scheduledFor) : null;
        if (scheduled && !scheduleSlots(store, hours, loaded.now).some((s) => s.start.getTime() === scheduled.getTime()))
          pending.push({ codigo: "SLOT_INVALIDO", dica: "A faixa agendada não vale mais: ofereça outra." });
        if (pausedOf(loaded.settings)) pending.push({ codigo: "LOJA_PAUSADA", dica: "A loja pausou os pedidos agora." });
        else if (!scheduled && hours.enabled && !isOpenAt(hours, loaded.now))
          pending.push({
            codigo: "LOJA_FECHADA",
            dica: `A loja abre ${reopeningAt(hours, loaded.now)}.${store.scheduling.enabled ? " Ofereça agendar." : ""}`,
          });
        if (pending.length) return refuse(pending[0]!.codigo, pending.map((p) => p.dica).join(" "), { pendencias: pending });

        await loaded.tx.cart.update({ where: { id: cart.id }, data: { status: "AWAITING_CONFIRMATION" }, select: { id: true } });
        return {
          ok: true as const,
          resumo: cartSummary(computed, "AWAITING_CONFIRMATION"),
          formasDePagamento: effectivePaymentMethods(store),
          proximoPasso: "Mande o resumo ao cliente e peça a confirmação. Qualquer mudança no carrinho exige novo resumo.",
        };
      }),
  });

  return [adicionar_ao_carrinho, alterar_item_carrinho, remover_do_carrinho, ver_carrinho, definir_dados_entrega, resumir_pedido];
}
