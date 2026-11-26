import { createPrismaClient, withTenants } from "@dishdesk/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmToolContext } from "../src/ai/llm-provider.js";
import { menuAgentTools } from "../src/menu-agent/tools/index.js";
import { admin, createAuthFixture } from "./helpers.js";

// Ferramentas do agente de pedidos (F4-01, F4-02), chamadas como o LlmProvider chama: input validado pelo schema e
// o tenantId do sistema no ctx.
describe("Agente de pedidos: ferramentas de leitura e do carrinho (F4-01, F4-02)", () => {
  const db = createPrismaClient(process.env.DATABASE_URL ?? "");
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let ids: Record<string, string>;
  let itemOfB: string;
  let conversationId: string;
  let contactId: string;
  // Sexta, 20/11/2026: 20:00 em Brasília (aberto) e 15:00 (fechado; abre às 18:00).
  const OPEN_AT = new Date("2026-11-20T23:00:00Z");
  const CLOSED_AT = new Date("2026-11-20T18:00:00Z");
  let now = OPEN_AT;

  const settings = {
    businessHours: { enabled: true, days: Array.from({ length: 7 }, () => [{ open: "18:00", close: "23:30" }]), closedMessage: "Fechado." },
    menuStore: {
      address: { street: "Rua A", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "01000-000" },
      pickupEnabled: true,
      prepMinutes: 30,
      delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 800 }] },
      minOrderCents: 3000,
      freeDeliveryFromCents: 15000,
      deliveryMinMinutes: 40,
      deliveryMaxMinutes: 60,
      paymentMethods: ["pix", "cash"],
      scheduling: { enabled: true, minLeadMinutes: 60, slotMinutes: 30 },
      promoShowcase: { itemIds: [], frequencyHours: 24 },
    },
  };

  const tools = () =>
    menuAgentTools({ db: { withTenants: (scope, fn) => withTenants(db, scope, fn) }, now: () => now }, { conversationId, contactId });
  /** Como o LlmProvider: o schema limpa o input e o ctx traz o restaurante da conversa. */
  async function call(name: string, input: object = {}, ctx: LlmToolContext = { tenantId: fx.a.id }) {
    const tool = tools().find((t) => t.name === name)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await tool.handler(tool.inputSchema.parse(input), ctx)) as any;
  }

  async function seed(tenantId: string) {
    const menu = await admin.menu.create({ data: { tenantId, name: "Cardápio" } });
    const pizzas = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Pizzas", allowsHalf: true, halfPricing: "SUM" } });
    const drinks = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Bebidas", sortOrder: 1 } });
    const catupiry = await admin.menuChoice.create({ data: { tenantId, menuId: menu.id, name: "Catupiry" } });
    const border = await admin.menuOptionGroup.create({
      data: { tenantId, menuId: menu.id, name: "Borda", minSelect: 0, maxSelect: 1, options: { create: [{ tenantId, choiceId: catupiry.id, name: "Catupiry", priceCents: 1000 }] } },
      include: { options: true },
    });
    const pizza = (name: string, grande: number, broto: number | null, extra: object = {}) =>
      admin.menuItem.create({
        data: {
          tenantId,
          categoryId: pizzas.id,
          name,
          servesPeople: 2,
          sizes: { create: [{ tenantId, name: "Grande", priceCents: grande, sortOrder: 1 }, ...(broto ? [{ tenantId, name: "Broto", priceCents: broto }] : [])] },
          ...extra,
        },
        include: { sizes: true },
      });
    const calabresa = await pizza("Calabresa", 5000, 3000, { ingredients: ["linguiça calabresa", "cebola"], aiNotes: "Sugira a borda de catupiry." });
    const margherita = await pizza("Margherita", 4600, 2800, { tags: ["vegetariano"], ingredients: ["muçarela", "tomate", "manjericão"] });
    const portuguesa = await pizza("Portuguesa", 5200, null, { ingredients: ["presunto", "ovo", "ervilha"] });
    await admin.menuItemOptionGroup.create({ data: { tenantId, itemId: calabresa.id, groupId: border.id } });
    const refri = await admin.menuItem.create({ data: { tenantId, categoryId: drinks.id, name: "Refrigerante lata", priceCents: 800 } });
    const grande = (item: typeof calabresa) => item.sizes.find((s) => s.name === "Grande")!.id;
    return {
      calabresa: calabresa.id,
      calabresaGrande: grande(calabresa),
      margherita: margherita.id,
      portuguesa: portuguesa.id,
      catupiry: border.options[0]!.id,
      refri: refri.id,
    };
  }

  const cartOf = () => admin.cart.findFirstOrThrow({ where: { tenantId: fx.a.id, conversationId } });

  beforeAll(async () => {
    fx = await createAuthFixture();
    await admin.tenant.update({ where: { id: fx.a.id }, data: { settings } });
    ids = await seed(fx.a.id);
    itemOfB = (await seed(fx.b.id)).calabresa;
    const channel = await admin.channel.create({
      data: { tenantId: fx.a.id, type: "WHATSAPP", name: "+55 11 90000-0002", externalId: `wa-agente-${fx.a.id}`, credentials: new Uint8Array(), status: "CONNECTED" },
    });
    contactId = (await admin.contact.create({ data: { tenantId: fx.a.id, name: "Bruna" } })).id;
    conversationId = (await admin.conversation.create({ data: { tenantId: fx.a.id, contactId, channelId: channel.id, status: "OPEN" } })).id;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await db.$disconnect();
  });

  it("buscar_cardapio tolera erro de escrita, começo do nome e ingrediente", async () => {
    for (const termo of ["calab", "calabreza", "Linguiça"]) {
      const { itens } = await call("buscar_cardapio", { termo });
      expect(itens[0]?.nome, termo).toBe("Calabresa");
    }
    const first = (await call("buscar_cardapio", { termo: "calabreza" })).itens[0];
    expect(first).toMatchObject({ itemId: ids.calabresa, precoAPartirDe: { texto: "R$ 30,00", centavos: 3000 }, disponivel: true });
    expect((await call("buscar_cardapio", { termo: "sushi" })).itens).toEqual([]);
  });

  it("detalhar_item traz tamanhos, meio a meio e a nota do restaurante; item de outro restaurante não existe", async () => {
    const detail = await call("detalhar_item", { itemId: ids.calabresa });
    expect(detail.tamanhos.map((s: { nome: string }) => s.nome)).toEqual(["Broto", "Grande"]);
    expect(detail.meioAMeio).toEqual({ permitido: true, regra: expect.stringContaining("soma") });
    expect(detail.notaDoRestaurante).toBe("Sugira a borda de catupiry.");
    expect(detail.complementos[0]).toMatchObject({ grupo: "Borda", minimo: 0, maximo: 1 });
    expect(await call("detalhar_item", { itemId: itemOfB })).toMatchObject({ ok: false, codigo: "ITEM_NOT_FOUND" });
  });

  it("tenantId no input do modelo é ignorado: vale o do ctx", async () => {
    const forged = await call("detalhar_item", { itemId: itemOfB, tenantId: fx.b.id });
    expect(forged).toMatchObject({ ok: false, codigo: "ITEM_NOT_FOUND" });
    // A mesma chamada no restaurante certo acha o item (o id é válido, só não é de A).
    expect(await call("detalhar_item", { itemId: itemOfB }, { tenantId: fx.b.id })).toMatchObject({ itemId: itemOfB });
    const tool = tools().find((t) => t.name === "adicionar_ao_carrinho")!;
    expect(tool.inputSchema.parse({ itemId: ids.refri, tenantId: fx.b.id })).not.toHaveProperty("tenantId");
  });

  it("recomendar para 4 pessoas: duas pizzas de 2 pessoas, a preferência e o orçamento", async () => {
    const four = await call("recomendar", { pessoas: 4 });
    expect(four.sugestao.map((l: { nome: string; quantidade: number }) => [l.nome, l.quantidade])).toEqual([
      ["Margherita", 1],
      ["Calabresa", 1],
    ]);
    expect(four).toMatchObject({ servePessoas: 4, cobreTodos: true, total: { centavos: 9600 } });
    const veg = await call("recomendar", { pessoas: 4, preferencias: ["Vegetariano"] });
    expect(veg.sugestao).toEqual([expect.objectContaining({ nome: "Margherita", quantidade: 2 })]);
    const cheap = await call("recomendar", { pessoas: 4, orcamentoReais: 50 });
    expect(cheap).toMatchObject({ cobreTodos: false, total: { centavos: 4600 }, avisoOrcamento: expect.any(String) });
  });

  it("verificar_funcionamento: fechada informa a próxima abertura e as faixas de agendamento", async () => {
    now = CLOSED_AT;
    try {
      const status = await call("verificar_funcionamento");
      expect(status).toMatchObject({ status: "fechada", aberta: false, abre: "hoje às 18:00", horarioDeHoje: "18:00 às 23:30" });
      expect(status.agendamento.proximasFaixas[0]).toMatchObject({ faixa: "18:00–18:30", dia: "hoje" });
    } finally {
      now = OPEN_AT;
    }
    expect(await call("verificar_funcionamento")).toMatchObject({ status: "aberta", aberta: true });
  });

  it("adicionar sem o tamanho volta SIZE_REQUIRED com os tamanhos para perguntar", async () => {
    const result = await call("adicionar_ao_carrinho", { itemId: ids.calabresa });
    expect(result).toMatchObject({ ok: false, codigo: "SIZE_REQUIRED", dica: expect.stringContaining("tamanho") });
    expect(result.tamanhos.map((s: { nome: string; preco: { texto: string } }) => `${s.nome} ${s.preco.texto}`)).toEqual(["Broto R$ 30,00", "Grande R$ 50,00"]);
    expect(await admin.cart.count({ where: { conversationId } })).toBe(0);
  });

  it("meio a meio SUM soma os preços cheios das duas metades", async () => {
    const result = await call("adicionar_ao_carrinho", { itemId: ids.calabresa, tamanhoId: ids.calabresaGrande, outraMetadeId: ids.margherita });
    expect(result.ok).toBe(true);
    expect(result.carrinho.itens[0]).toMatchObject({ outraMetade: "Margherita", precoUnitario: { centavos: 9600 } });
    const half = await call("adicionar_ao_carrinho", { itemId: ids.calabresa, tamanhoId: ids.calabresaGrande, outraMetadeId: ids.refri });
    expect(half).toMatchObject({ ok: false, codigo: "HALF_OTHER_CATEGORY" });
    expect(half.saboresPossiveis.map((f: { nome: string }) => f.nome)).toEqual(["Margherita", "Portuguesa"]);
    await call("remover_do_carrinho", { cartItemId: result.carrinho.itens[0].cartItemId });
  });

  it("totais com taxa de entrega e frete grátis a partir do piso", async () => {
    const added = await call("adicionar_ao_carrinho", { itemId: ids.calabresa, tamanhoId: ids.calabresaGrande, complementoIds: [ids.catupiry] });
    const line = added.carrinho.itens[0];
    expect(line).toMatchObject({ precoUnitario: { centavos: 6000 }, complementos: ["Catupiry (+R$ 10,00)"] });
    expect(await call("calcular_entrega", { cep: "01000-000" })).toMatchObject({ ok: false, codigo: "ADDRESS_REQUIRED", dica: expect.stringContaining("bairro") });
    expect(await call("calcular_entrega", { endereco: { bairro: "Centro" } })).toMatchObject({ ok: true, taxa: { centavos: 800 }, faltaParaFreteGratis: { centavos: 9000 } });
    expect(await call("definir_dados_entrega", { modo: "entrega", endereco: { bairro: "Lapa", rua: "Rua X" } })).toMatchObject({ ok: false, codigo: "OUT_OF_AREA" });
    const set = await call("definir_dados_entrega", { modo: "entrega", endereco: { rua: "Rua das Flores", numero: "10", bairro: "centro" }, localizacao: { lat: -23.5, lng: -46.6 } });
    expect(set.carrinho).toMatchObject({ subtotal: { centavos: 6000 }, entrega: { modo: "entrega", taxa: { centavos: 800 } }, total: { centavos: 6800 } });
    const more = await call("alterar_item_carrinho", { cartItemId: line.cartItemId, quantidade: 3 });
    expect(more.carrinho).toMatchObject({ subtotal: { centavos: 18000 }, entrega: { taxa: { centavos: 0 }, freteGratis: true }, total: { centavos: 18000 } });
    expect((await cartOf()).deliveryAddress).toMatchObject({ mode: "DELIVERY", district: "centro", lat: -23.5, lng: -46.6 });
  });

  it("resumir_pedido aguarda a confirmação; mudar o carrinho depois volta a DRAFT", async () => {
    const summary = await call("resumir_pedido");
    expect(summary).toMatchObject({
      ok: true,
      resumo: { status: "AWAITING_CONFIRMATION", subtotal: { centavos: 18000 }, total: { centavos: 18000 }, entrega: { prazoMinutos: { min: 40, max: 60 } } },
      formasDePagamento: ["cash"],
    });
    expect((await cartOf()).status).toBe("AWAITING_CONFIRMATION");
    // Um carrinho aberto por conversa: o novo item entra no mesmo e o devolve a DRAFT.
    const refri = await call("adicionar_ao_carrinho", { itemId: ids.refri });
    expect(refri.carrinho).toMatchObject({ status: "DRAFT", total: { centavos: 18800 } });
    expect(await admin.cart.findMany({ where: { conversationId }, select: { status: true } })).toEqual([{ status: "DRAFT" }]);
  });

  it("com a loja fechada, o resumo pede o agendamento", async () => {
    now = CLOSED_AT;
    try {
      const closed = await call("resumir_pedido");
      expect(closed).toMatchObject({ ok: false, codigo: "LOJA_FECHADA", dica: expect.stringContaining("hoje às 18:00") });
      const { agendamento } = await call("verificar_funcionamento");
      await call("definir_dados_entrega", { modo: "retirada", agendarPara: agendamento.proximasFaixas[0].inicio });
      const scheduled = await call("resumir_pedido");
      expect(scheduled).toMatchObject({ ok: true, resumo: { entrega: { modo: "retirada", agendadoPara: "hoje, 18:00–18:30", taxa: { centavos: 0 } } } });
    } finally {
      now = OPEN_AT;
    }
  });
});
