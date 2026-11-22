import { HttpException } from "@nestjs/common";
import { menuStoreOf } from "@dishdesk/shared";
import { z } from "zod";
import type { PixPending, PlacedOrder, PlaceOrderInput } from "../../public/public-order.service.js";
import type { CartDelivery } from "./cart-tools.js";
import { defineTool, type MenuAgentDeps, type MenuAgentSession, money, refuse, withMenu } from "./context.js";

/**
 * Quem fecha o pedido e cobra o Pix (o PublicOrderService, com as mesmas regras do site). Só o turno real recebe isto:
 * na simulação do painel (C4) as ferramentas respondem que é simulação e nada é criado.
 */
export type AgentOrders = {
  place(tenantId: string, contactId: string, input: PlaceOrderInput & { cartId: string }): Promise<PlacedOrder | PixPending>;
  pixStatus(tenantId: string, paymentId: string): Promise<{ status: string; orderCode: string | null; expiresAt: string | null } | null>;
  /** Link do cardápio com o carrinho da conversa (F3-11). */
  contextLink(tenantId: string, conversationId: string): Promise<string | null>;
};

const PAY_ON_DELIVERY = ["cash", "credit", "debit", "pix_on_delivery"] as const;

/** Erro das regras do pedido (HttpException com código) → resposta para o modelo. */
function refusalOf(error: unknown) {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { code?: string; message?: unknown };
    const message = Array.isArray(body.message) ? String(body.message[0]) : typeof body.message === "string" ? body.message : error.message;
    return refuse(body.code ?? "PEDIDO_RECUSADO", `${message} Explique ao cliente e ajuste (ou use transferir_para_humano).`);
  }
  throw error;
}

/**
 * Fechamento do pedido pelo agente (F4-03): `confirmar_pedido` (pagar na entrega ou na retirada), `gerar_pix` (o pedido
 * só nasce pago) e `consultar_pagamento`. Exigem o resumo já mostrado (carrinho em AWAITING_CONFIRMATION): qualquer
 * mudança depois dele volta a DRAFT. A chave do envio é o id do carrinho, então a chamada repetida não duplica o pedido.
 */
export function orderTools(deps: MenuAgentDeps, session: MenuAgentSession, orders: AgentOrders | null, onPix: (pix: PixPending) => void) {
  /** O carrinho confirmado convertido no corpo do pedido; ou a recusa com o que falta. */
  const confirmedCart = (ctx: { tenantId: string }, payment: PlaceOrderInput["payment"]) =>
    withMenu(deps, ctx, async (loaded) => {
      if (!orders) return refuse("SIMULACAO", "Simulação: o pedido não é criado. Diga que o pedido seria confirmado agora.");
      if (!session.contactId) return refuse("SEM_CONTATO", "Conversa sem contato: use transferir_para_humano.");
      const cart = await loaded.tx.cart.findFirst({
        where: { tenantId: loaded.tenantId, conversationId: session.conversationId, status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] } },
        orderBy: { createdAt: "desc" },
        include: { items: { orderBy: { createdAt: "asc" } } },
      });
      if (!cart?.items.length) return refuse("CARRINHO_VAZIO", "O carrinho está vazio.");
      if (cart.status !== "AWAITING_CONFIRMATION") return refuse("RESUMO_PENDENTE", "Use resumir_pedido, mande o resumo e espere o cliente confirmar.");
      const delivery = cart.deliveryAddress as CartDelivery | null;
      if (!delivery) return refuse("DADOS_DE_ENTREGA", "Pergunte entrega ou retirada e use definir_dados_entrega.");
      const store = menuStoreOf(loaded.settings);
      const input: PlaceOrderInput & { cartId: string } = {
        idempotencyKey: cart.id,
        cartId: cart.id,
        lines: cart.items.map((row) => ({
          lineId: row.id,
          itemId: row.itemId,
          sizeId: row.sizeId,
          optionIds: Array.isArray(row.options) ? (row.options as { id: string }[]).map((o) => o.id) : [],
          halves: row.halves,
          quantity: row.quantity,
          note: row.notes,
        })),
        fulfillment:
          delivery.mode === "PICKUP"
            ? { mode: "PICKUP" }
            : {
                mode: "DELIVERY",
                address: {
                  street: delivery.street ?? "Localização enviada pelo WhatsApp",
                  number: delivery.number ?? "",
                  complement: delivery.complement ?? null,
                  district: delivery.district ?? "",
                  city: delivery.city ?? store.address.city,
                  state: store.address.state,
                  zipCode: delivery.zip ?? null,
                  reference: delivery.reference ?? null,
                },
                lat: delivery.lat ?? null,
                lng: delivery.lng ?? null,
              },
        when: delivery.scheduledFor ? { kind: "scheduled", start: delivery.scheduledFor } : { kind: "now" },
        payment,
        notes: cart.notes,
      };
      return { ok: true as const, input, contactId: session.contactId, orders };
    });

  const confirmar_pedido = defineTool({
    name: "confirmar_pedido",
    description:
      "Fecha o pedido com pagamento na entrega ou na retirada, depois que o cliente confirmou o resumo. Formas: cash (dinheiro), credit, debit, pix_on_delivery (Pix na maquininha). Repetir não duplica.",
    inputSchema: z.object({
      formaDePagamento: z.enum(PAY_ON_DELIVERY),
      trocoParaCentavos: z.number().int().positive().max(10_000_000).optional().describe("Só no dinheiro, quando o cliente pediu troco"),
    }),
    handler: async (input, ctx) => {
      const ready = await confirmedCart(ctx, { method: input.formaDePagamento, changeForCents: input.formaDePagamento === "cash" ? (input.trocoParaCentavos ?? null) : null });
      if (!ready.ok) return ready;
      try {
        const placed = await ready.orders.place(ctx.tenantId, ready.contactId, ready.input);
        if ("kind" in placed) return refuse("PAGAMENTO_INVALIDO", "Use gerar_pix para o Pix online.");
        return {
          ok: true as const,
          pedido: placed.code,
          proximoPasso: "Pedido feito. O sistema manda a confirmação com o número e o prazo: agradeça em uma frase, sem repetir valores.",
        };
      } catch (error) {
        return refusalOf(error);
      }
    },
  });

  const gerar_pix = defineTool({
    name: "gerar_pix",
    description:
      "Gera o Pix online do pedido confirmado (só se a loja aceita Pix). Precisa do CPF de quem paga. O pedido só entra quando o pagamento cair; vale também para gerar outro Pix depois de vencer.",
    inputSchema: z.object({ cpf: z.string().max(20).describe("CPF informado pelo cliente") }),
    handler: async (input, ctx) => {
      const ready = await confirmedCart(ctx, { method: "pix", cpf: input.cpf });
      if (!ready.ok) return ready;
      try {
        const placed = await ready.orders.place(ctx.tenantId, ready.contactId, ready.input);
        if (!("kind" in placed)) return { ok: true as const, pedido: placed.code, proximoPasso: "Esse pedido já foi feito." };
        onPix(placed);
        return {
          ok: true as const,
          valor: money(placed.amountCents),
          venceEm: placed.expiresAt,
          proximoPasso:
            "O sistema manda agora o QR Code e, numa mensagem separada, o código copia e cola. Diga só que o Pix foi gerado e que o pedido entra assim que o pagamento cair. Não escreva o código.",
        };
      } catch (error) {
        return refusalOf(error);
      }
    },
  });

  const consultar_pagamento = defineTool({
    name: "consultar_pagamento",
    description: "Situação do último Pix desta conversa, conferida no banco. O comprovante do cliente não vale: só esta consulta.",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      if (!orders) return refuse("SIMULACAO", "Simulação: não há Pix gerado.");
      const last = await deps.db.withTenants({ tenantIds: [ctx.tenantId] }, (tx) =>
        tx.payment.findFirst({ where: { tenantId: ctx.tenantId, cart: { conversationId: session.conversationId } }, orderBy: { createdAt: "desc" }, select: { id: true } }),
      );
      if (!last) return refuse("SEM_PIX", "Nenhum Pix foi gerado nesta conversa.");
      const status = await orders.pixStatus(ctx.tenantId, last.id);
      if (!status) return refuse("SEM_PIX", "Nenhum Pix foi gerado nesta conversa.");
      const text: Record<string, string> = {
        PENDING: "Ainda não caiu. Peça para o cliente aguardar alguns instantes.",
        PAID: "Pago: o pedido já entrou e o sistema mandou a confirmação.",
        EXPIRED: "Venceu sem pagamento. Ofereça gerar outro (gerar_pix).",
        CANCELED: "Cancelado. Ofereça gerar outro (gerar_pix) ou pagar na entrega.",
        REFUNDED: "Estornado: use transferir_para_humano.",
      };
      return { ok: true as const, situacao: status.status, ...(status.orderCode ? { pedido: status.orderCode } : {}), dica: text[status.status] ?? "" };
    },
  });

  const link_do_cardapio = defineTool({
    name: "link_do_cardapio",
    description:
      "Link do cardápio no site, já com a sacola desta conversa (vale 24 h). Use quando o cliente quiser ver as fotos, escolher pelo site ou terminar o pedido por lá.",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      if (!orders) return refuse("SIMULACAO", "Simulação: diga que mandaria o link do cardápio.");
      const link = await orders.contextLink(ctx.tenantId, session.conversationId);
      if (!link) return refuse("SEM_CARDAPIO", "O cardápio não tem link: use transferir_para_humano.");
      return { ok: true as const, link, dica: "Mande o link como está, numa linha só. Se o carrinho tiver itens, eles já aparecem na sacola do site." };
    },
  });

  return [confirmar_pedido, gerar_pix, consultar_pagamento, link_do_cardapio];
}
