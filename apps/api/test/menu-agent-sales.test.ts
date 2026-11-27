import { createPrismaClient, withTenants } from "@dishdesk/database";
import type { SalesRule } from "@dishdesk/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MenuAgentDeps, menuAgentTools } from "../src/menu-agent/tools/index.js";
import { type SalesItem, type SalesLine, salesOffersFor, salesRemaining, salesTool } from "../src/menu-agent/tools/sales-tool.js";
import { admin, createAuthFixture } from "./helpers.js";

// Venda pela IA (E48): as regras por categoria decidem o que a IA oferece e quando.
describe("Venda pela IA: ofertas por categoria (E48)", () => {
  const item = (id: string, categoryId: string, extra: Partial<SalesItem> = {}): SalesItem => ({
    id,
    name: id,
    categoryId,
    available: true,
    fromCents: 1000,
    groups: [],
    pairsWith: [],
    ...extra,
  });
  const combo = { id: "combo", name: "Transformar em combo", optionIds: ["opt-combo"], options: [{ id: "opt-combo", name: "Refri + batata", priceCents: 1000 }] };
  const items = new Map(
    [
      item("x-burger", "burgers", { groups: [combo], pairsWith: ["batata"] }),
      item("calabresa", "pizzas", { pairsWith: ["refri-2l"] }),
      item("refri-2l", "drinks"),
      item("refri-lata", "drinks"),
      item("suco", "drinks", { available: false }),
      item("pudim", "desserts"),
      item("batata", "sides"),
    ].map((i) => [i.id, i]),
  );
  const categories = new Map([
    ["burgers", "Hambúrgueres"],
    ["pizzas", "Pizzas"],
    ["drinks", "Bebidas"],
    ["desserts", "Sobremesas"],
    ["sides", "Porções"],
  ]);
  const rule = (r: Partial<SalesRule> & Pick<SalesRule, "id" | "trigger" | "categoryId">): SalesRule => ({ itemIds: [], groupIds: [], pitch: "", ...r });
  const rules = [
    rule({ id: "combo", trigger: "ON_ADD", categoryId: "burgers", groupIds: ["combo"], pitch: "refri e batata por só +R$ 10" }),
    rule({ id: "pizza", trigger: "ON_ADD", categoryId: "pizzas", itemIds: ["refri-2l"] }),
    rule({ id: "bebida", trigger: "AT_END", categoryId: "drinks" }),
    rule({ id: "sobremesa", trigger: "AT_END", categoryId: "desserts", itemIds: ["pudim"] }),
  ];
  const line = (itemId: string, optionIds: string[] = []): SalesLine => ({ cartItemId: `line-${itemId}`, itemId, optionIds });
  const offers = (moment: "ON_ADD" | "AT_END", lines: SalesLine[], extra: { usePairings?: boolean; top?: string[] } = {}) =>
    salesOffersFor({ moment, rules, usePairings: extra.usePairings ?? true, lines, items, categories, topOf: () => extra.top ?? [] });

  it("hambúrguer: oferece o combo na linha, com os complementos que ela já tem", () => {
    const [offer] = offers("ON_ADD", [line("x-burger", ["opt-bacon"])]);
    expect(offer).toMatchObject({
      regraId: "combo",
      motivo: "o cliente pediu x-burger (Hambúrgueres)",
      itens: [],
      argumento: "refri e batata por só +R$ 10",
      complementos: [{ cartItemId: "line-x-burger", grupo: "Transformar em combo", complementoIdsAtuais: ["opt-bacon"], opcoes: [{ complementoId: "opt-combo", preco: { centavos: 1000 } }] }],
    });
    // Já é combo: nada a oferecer. O "Combina com" do hambúrguer não vale, porque a categoria tem regra.
    expect(offers("ON_ADD", [line("x-burger", ["opt-combo"])])).toEqual([]);
  });

  it("pizza: oferece o refri 2L, e não oferece o que já está no carrinho", () => {
    expect(offers("ON_ADD", [line("calabresa")]).map((o) => [o.regraId, o.itens.map((i) => i.itemId)])).toEqual([["pizza", ["refri-2l"]]]);
    expect(offers("ON_ADD", [line("calabresa"), line("refri-2l")])).toEqual([]);
  });

  it("no fim: bebida pelos mais vendidos (sem esgotado) e sobremesa pelo item escolhido; pula a categoria que já está no carrinho", () => {
    const end = offers("AT_END", [line("calabresa")], { top: ["suco", "refri-lata"] });
    expect(end.map((o) => [o.regraId, o.itens.map((i) => i.itemId)])).toEqual([
      ["bebida", ["refri-lata", "refri-2l"]],
      ["sobremesa", ["pudim"]],
    ]);
    expect(end[0]!.motivo).toBe("o carrinho não tem nada de Bebidas");
    expect(offers("AT_END", [line("calabresa"), line("refri-lata")]).map((o) => o.regraId)).toEqual(["sobremesa"]);
    expect(offers("AT_END", [])).toEqual([]);
  });

  it('"Combina com" só nas categorias sem regra e só se ligado', () => {
    const noRule = salesOffersFor({ moment: "ON_ADD", rules: [], usePairings: true, lines: [line("x-burger")], items, categories, topOf: () => [] });
    expect(noRule.map((o) => o.regraId)).toEqual(["combina:x-burger"]);
    expect(salesOffersFor({ moment: "ON_ADD", rules: [], usePairings: false, lines: [line("x-burger")], items, categories, topOf: () => [] })).toEqual([]);
  });

  it("regra de categoria apagada não oferece nada", () => {
    expect(salesOffersFor({ moment: "AT_END", rules: [rule({ id: "x", trigger: "AT_END", categoryId: "sumiu" })], usePairings: false, lines: [line("calabresa")], items, categories, topOf: () => [] })).toEqual([]);
  });

  it("limite por conversa e Venda pela IA desligada", () => {
    expect(salesRemaining({}, [])).toBe(2);
    expect(salesRemaining({}, ["a", "b"])).toBe(0);
    expect(salesRemaining({ menuAgent: { suggestAddons: false } }, [])).toBe(0);
  });

  describe("ofertas_de_venda com o banco", () => {
    const db = createPrismaClient(process.env.DATABASE_URL ?? "");
    let fx: Awaited<ReturnType<typeof createAuthFixture>>;
    let conversationId: string;
    let contactId: string;
    const ids: Record<string, string> = {};
    const deps: MenuAgentDeps = { db: { withTenants: (scope, fn) => withTenants(db, scope, fn) } };

    beforeAll(async () => {
      fx = await createAuthFixture();
      const tenantId = fx.a.id;
      const menu = await admin.menu.create({ data: { tenantId, name: "Cardápio" } });
      const burgers = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Hambúrgueres" } });
      const drinks = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Bebidas", sortOrder: 1 } });
      const choice = await admin.menuChoice.create({ data: { tenantId, menuId: menu.id, name: "Refri + batata" } });
      const group = await admin.menuOptionGroup.create({
        data: { tenantId, menuId: menu.id, name: "Transformar em combo", minSelect: 0, maxSelect: 1, options: { create: [{ tenantId, choiceId: choice.id, name: "Refri + batata", priceCents: 1000 }] } },
        include: { options: true },
      });
      const burger = await admin.menuItem.create({ data: { tenantId, categoryId: burgers.id, name: "X-Burger", priceCents: 2500 } });
      await admin.menuItemOptionGroup.create({ data: { tenantId, itemId: burger.id, groupId: group.id } });
      const refri = await admin.menuItem.create({ data: { tenantId, categoryId: drinks.id, name: "Refri lata", priceCents: 700 } });
      Object.assign(ids, { burger: burger.id, refri: refri.id, combo: group.options[0]!.id });
      await admin.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            menuAgent: {
              maxSuggestionsPerConversation: 2,
              salesRules: [
                { id: "combo", trigger: "ON_ADD", categoryId: burgers.id, groupIds: [group.id] },
                { id: "bebida", trigger: "AT_END", categoryId: drinks.id },
              ],
            },
          },
        },
      });
      const channel = await admin.channel.create({
        data: { tenantId, type: "WHATSAPP", name: "WhatsApp", externalId: `wa-vendas-${tenantId}`, credentials: new Uint8Array(), status: "CONNECTED" },
      });
      contactId = (await admin.contact.create({ data: { tenantId, name: "Caio" } })).id;
      conversationId = (await admin.conversation.create({ data: { tenantId, contactId, channelId: channel.id, status: "OPEN" } })).id;
    });

    afterAll(async () => {
      await fx?.cleanup();
      await db.$disconnect();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = async (tool: { handler: (input: any, ctx: { tenantId: string }) => unknown }, input: object) => (await tool.handler(input, { tenantId: fx.a.id })) as any;

    it("oferece o combo, aplica pelo alterar_item_carrinho, depois a bebida no fim; cada oferta uma vez", async () => {
      const session = { conversationId, contactId };
      const cartTools = menuAgentTools(deps, session);
      const add = cartTools.find((t) => t.name === "adicionar_ao_carrinho")!;
      const change = cartTools.find((t) => t.name === "alterar_item_carrinho")!;
      await run(add, { itemId: ids.burger, quantidade: 1 });

      const made: string[] = [];
      const tool = salesTool(deps, session, [], (id) => made.push(id));
      const first = await run(tool, { momento: "depois_de_adicionar" });
      expect(first.oferta).toMatchObject({ regraId: "combo", complementos: [{ grupo: "Transformar em combo", opcoes: [{ complementoId: ids.combo, preco: { texto: "R$ 10,00" } }] }] });
      // Mesma oferta não volta no mesmo atendimento.
      expect((await run(tool, { momento: "depois_de_adicionar" })).oferta).toBeNull();

      const line = first.oferta.complementos[0];
      const changed = await run(change, { cartItemId: line.cartItemId, complementoIds: [...line.complementoIdsAtuais, ids.combo] });
      expect(changed.carrinho.total.centavos).toBe(3500);

      const end = await run(tool, { momento: "fim" });
      expect(end.oferta).toMatchObject({ regraId: "bebida", itens: [{ itemId: ids.refri, nome: "Refri lata" }] });
      expect(made).toEqual(["combo", "bebida"]);
      // Limite de 2 atingido.
      expect((await run(salesTool(deps, session, made, () => undefined), { momento: "fim" })).oferta).toBeNull();
    });
  });
});
