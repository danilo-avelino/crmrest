import { readFileSync } from "node:fs";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parsePriceCents, planImport, readMenuCsv } from "../src/menu/menu-import.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const HEADER = "categoria;item;descricao;preco;tamanho;preco_tamanho;ingredientes;alergenos;serve_pessoas;tags;apelidos";
const plan = (csv: string, existing = new Map<string, Set<string>>()) => planImport(readMenuCsv(csv), existing);

describe("Importação CSV do cardápio (F2-09): leitura e plano", () => {
  it("preços em vários formatos viram centavos", () => {
    expect(["49,90", "49.90", "R$ 49,90", "R$49,90", " 50 ", "1.250,00", "1,250.00", "1.250", "0,5", "0.500"].map(parsePriceCents)).toEqual([
      4990, 4990, 4990, 4990, 5000, 125000, 125000, 125000, 50, 50,
    ]);
    expect(parsePriceCents("")).toBeNull();
    expect(parsePriceCents("abc")).toBeNaN();
    expect(parsePriceCents("-3")).toBeNaN();
  });

  it("detecta o separador e lê aspas, quebra de linha dentro do campo, CRLF e BOM", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a,b,c")).toBe(",");
    expect(detectDelimiter('"a,b";c;d')).toBe(";");
    expect(detectDelimiter("a\tb")).toBe("\t");
    const records = parseCsv('﻿a;"x;y";"diz ""oi"""\r\n\r\n1;"duas\nlinhas";3\r\n4;5;6', ";");
    expect(records).toEqual([
      { line: 1, cells: ["a", "x;y", 'diz "oi"'] },
      { line: 3, cells: ["1", "duas\nlinhas", "3"] },
      { line: 5, cells: ["4", "5", "6"] },
    ]);
    expect(() => parseCsv('a;"aberta', ";")).toThrow(/aspas/);
  });

  it("aceita vírgula e cabeçalho com acento e maiúsculas", () => {
    const csv = "Categoria,Item,Descrição,Preço\nPizzas,Mussarela,\"Queijo, molho\",\"R$ 40,00\"\n";
    const { rows, plan: result } = plan(csv);
    expect(rows[0]!.errors).toEqual([]);
    expect(result).toEqual([
      { name: "Pizzas", existing: false, items: [expect.objectContaining({ name: "Mussarela", description: "Queijo, molho", priceCents: 4000, sizes: [] })] },
    ]);
  });

  it("recusa arquivo sem coluna obrigatória, vazio ou só com cabeçalho", () => {
    expect(() => readMenuCsv("item;preco\nA;1")).toThrow(/categoria/);
    expect(() => readMenuCsv("categoria;item\nA;B")).toThrow(/preco/);
    expect(() => readMenuCsv("")).toThrow(/vazio/);
    expect(() => readMenuCsv(HEADER)).toThrow(/nenhum item/);
    expect(() => readMenuCsv("x".repeat(1_000_001))).toThrow(/1 MB/);
  });

  it("o modelo de exemplo importa sem erro: 3 categorias, 4 itens, 4 tamanhos", () => {
    const text = readFileSync(new URL("../../../docs/cardapio-ia/modelo-cardapio.csv", import.meta.url), "utf8");
    const { rows, counts, plan: result } = plan(text);
    expect(rows).toHaveLength(6);
    expect(rows.flatMap((row) => row.errors)).toEqual([]);
    expect(counts).toEqual({ rows: 6, validRows: 6, invalidRows: 0, categories: 3, items: 4, sizes: 4 });
    const calabresa = result[0]!.items[0]!;
    expect(calabresa).toMatchObject({
      name: "Calabresa",
      priceCents: null,
      sizes: [{ name: "Média", priceCents: 4990 }, { name: "Grande", priceCents: 6290 }],
      ingredients: ["molho de tomate", "mussarela", "linguiça calabresa", "cebola", "azeitona"],
      allergens: ["glúten", "lactose"],
      servesPeople: 2,
      synonyms: ["calabreza", "linguiça"],
    });
    expect(result[1]!.items[0]).toMatchObject({ name: "Coca-Cola 2L", priceCents: 1400 });
  });

  it("erros por linha, em português, com o número da linha do arquivo", () => {
    const csv = [
      HEADER,
      ";Sem categoria;;10;;;;;;;",
      "Pizzas;;;10;;;;;;;",
      "Pizzas;Sem preço;;;;;;;;;",
      "Pizzas;Preço ruim;;doze;;;;;;;",
      "Pizzas;Serve mal;;10;;;;;0;;",
      "Pizzas;Tamanho sem preço;;;Grande;;;;;;",
      "Pizzas;Boa;;10;;;;;;;",
      "Pizzas;Repetida;;10;;;;;;;",
      "pizzas;REPETIDA;;11;;;;;;;",
    ].join("\n");
    const { rows, counts } = plan(csv);
    expect(rows.map((row) => [row.line, row.errors[0]])).toEqual([
      [2, "Falta a categoria."],
      [3, "Falta o nome do item."],
      [4, "Falta o preço (ou o tamanho com o preço dele)."],
      [5, 'Preço inválido: "doze".'],
      [6, 'Serve quantas pessoas: "0" não é um número de 1 a 100.'],
      [7, "Falta o preço do tamanho."],
      [8, undefined],
      [9, "Outra linha deste item tem erro: corrija-a para importar o item."],
      [10, "Item repetido (já aparece na linha 9). Para tamanhos diferentes, preencha a coluna tamanho."],
    ]);
    expect(counts).toMatchObject({ rows: 9, validRows: 1, invalidRows: 8, items: 1 });
  });

  it("mesma categoria + item com tamanhos diferentes vira um item com tamanhos; preço único e tamanho não se misturam", () => {
    const sized = plan([HEADER, "Pizzas;Mista;Desc;;Média;40;;;;;", "pizzas;mista;;;Grande;50;;;;;", "Pizzas;Mista;;;média;45;;;;;"].join("\n"));
    expect(sized.rows[2]!.errors.join()).toContain('Tamanho "média" repetido');
    expect(sized.rows[0]!.errors).toEqual(["Outra linha deste item tem erro: corrija-a para importar o item."]);
    expect(sized.plan).toEqual([]);

    const ok = plan([HEADER, "Pizzas;Mista;Desc;;Média;40;;;;;", "pizzas;mista;;50;Grande;;;;;;"].join("\n"));
    expect(ok.rows.flatMap((row) => row.errors)).toEqual([]);
    expect(ok.plan[0]!.items).toHaveLength(1);
    expect(ok.plan[0]!.items[0]).toMatchObject({ description: "Desc", priceCents: null, sizes: [{ name: "Média", priceCents: 4000 }, { name: "Grande", priceCents: 5000 }] });

    const mixed = plan([HEADER, "Pizzas;Mista;;40;;;;;;;", "Pizzas;Mista;;;Grande;50;;;;;"].join("\n"));
    expect(mixed.rows[0]!.errors[0]).toContain("Outras linhas deste item têm tamanho");
  });

  it("item que já existe no cardápio é erro; categoria que já existe é reaproveitada", () => {
    const existing = new Map([["pizzas", new Set(["calabresa"])]]);
    const { rows, plan: result, counts } = plan([HEADER, "PIZZAS;Calabresa;;10;;;;;;;", "Pizzas;Nova;;12;;;;;;;"].join("\n"), existing);
    expect(rows[0]!.errors[0]).toContain("já existe");
    expect(result).toEqual([{ name: "Pizzas", existing: true, items: [expect.objectContaining({ name: "Nova" })] }]);
    expect(counts.categories).toBe(0);
  });
});

describe("Importação CSV do cardápio (F2-09): API", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let agentToken: string; // atendente em A
  let adminToken: string; // administrador em B
  const post = (tenantId: string, path: string, token = adminToken) =>
    request(app.getHttpServer()).post(`/api/menu/${tenantId}/import/csv/${path}`).set("Authorization", `Bearer ${token}`);
  const enable = (tenantId: string) => admin.tenantModule.upsert({ where: { tenantId_module: { tenantId, module: "MENU" } }, create: { tenantId, module: "MENU" }, update: {} });
  const csv = [HEADER, "Pizzas;Calabresa;Boa;;Média;49,90;;;;;", "Pizzas;Calabresa;;;Grande;62,90;;;;;", "Bebidas;Suco;;R$ 9,00;;;;;;;", "Bebidas;Quebrado;;x;;;;;;;"].join("\r\n");

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("sem o módulo MENU, preview e commit respondem 403", async () => {
    await post(fx.b.id, "preview").send({ csv }).expect(403);
    await post(fx.b.id, "commit").send({ rows: readMenuCsv(`${HEADER}\nX;Y;;1;;;;;;;`) }).expect(403);
    expect(await admin.menuCategory.count({ where: { tenantId: fx.b.id } })).toBe(0);
  });

  describe("com o módulo ligado", () => {
    beforeAll(async () => {
      await enable(fx.a.id);
      await enable(fx.b.id);
    });

    it("preview não grava; mostra erro por linha e o que será criado", async () => {
      const { body } = await post(fx.b.id, "preview").send({ csv }).expect(200);
      expect(body.counts).toEqual({ rows: 4, validRows: 3, invalidRows: 1, categories: 2, items: 2, sizes: 2 });
      expect(body.rows[3]).toMatchObject({ line: 5, errors: ['Preço inválido: "x".'] });
      expect(body.plan.map((c: { name: string }) => c.name)).toEqual(["Pizzas", "Bebidas"]);
      expect(await admin.menuCategory.count({ where: { tenantId: fx.b.id } })).toBe(0);
      await post(fx.b.id, "preview").send({ csv: "item;preco\nA;1" }).expect(400);
      await post(fx.b.id, "preview").send({ csv: "x".repeat(1_000_001) }).expect(400);
    });

    it("commit cria categorias, itens e tamanhos de uma vez e depois recusa duplicados", async () => {
      const { body: preview } = await post(fx.b.id, "preview").send({ csv }).expect(200);
      const valid = preview.rows.filter((row: { errors: string[] }) => row.errors.length === 0);
      const done = await post(fx.b.id, "commit").send({ rows: valid }).expect(201);
      expect(done.body).toEqual({ categories: 2, items: 2, sizes: 2 });

      const categories = await admin.menuCategory.findMany({ where: { tenantId: fx.b.id }, orderBy: { sortOrder: "asc" }, include: { items: { include: { sizes: { orderBy: { sortOrder: "asc" } } } } } });
      expect(categories.map((c) => [c.name, c.sortOrder, c.items.length])).toEqual([["Pizzas", 0, 1], ["Bebidas", 1, 1]]);
      expect(categories[0]!.items[0]).toMatchObject({ name: "Calabresa", priceCents: null, description: "Boa" });
      expect(categories[0]!.items[0]!.sizes.map((s) => [s.name, s.priceCents])).toEqual([["Média", 4990], ["Grande", 6290]]);
      expect(categories[1]!.items[0]).toMatchObject({ name: "Suco", priceCents: 900 });

      // Segunda vez: os itens já existem, nada é gravado.
      await post(fx.b.id, "commit").send({ rows: valid }).expect(400);
      expect(await admin.menuItem.count({ where: { tenantId: fx.b.id } })).toBe(2);

      // Categoria existente é reaproveitada.
      const more = readMenuCsv([HEADER, "pizzas;Mussarela;;40;;;;;;;"].join("\n"));
      await post(fx.b.id, "commit").send({ rows: more }).expect(201);
      expect(await admin.menuCategory.count({ where: { tenantId: fx.b.id } })).toBe(2);
      expect(await admin.menuItem.count({ where: { tenantId: fx.b.id, category: { name: "Pizzas" } } })).toBe(2);
    });

    it("commit revalida: linha inválida recusa tudo, sem gravar nada", async () => {
      const before = await admin.menuItem.count({ where: { tenantId: fx.b.id } });
      const rows = readMenuCsv([HEADER, "Massas;Lasanha;;30;;;;;;;"].join("\n"));
      const forged = [...rows, { ...rows[0]!, line: 3, item: "Sem preço", priceCents: null }];
      const res = await post(fx.b.id, "commit").send({ rows: forged }).expect(400);
      expect(res.body.message).toContain("Linha 3");
      expect(await admin.menuItem.count({ where: { tenantId: fx.b.id } })).toBe(before);
      expect(await admin.menuCategory.count({ where: { tenantId: fx.b.id, name: "Massas" } })).toBe(0);
    });

    it("atendente não importa; restaurante de fora (C) é 403; nada vaza para A", async () => {
      await post(fx.a.id, "preview", agentToken).send({ csv }).expect(403);
      await post(fx.a.id, "commit", agentToken).send({ rows: readMenuCsv([HEADER, "X;Y;;1;;;;;;;"].join("\n")) }).expect(403);
      await post(fx.c.id, "preview").send({ csv }).expect(403);
      await post(fx.a.id, "preview").send({ csv }).expect(403); // administrador de B não é membro de A
      expect(await admin.menuCategory.count({ where: { tenantId: { in: [fx.a.id, fx.c.id] } } })).toBe(0);
    });
  });
});
