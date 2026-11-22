import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../src/index.js";

// Busca do cardápio por trigramas (docs/cardapio-ia, F2-07): índice em app.menu_item_search_text.
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL não definida (copie .env.example para .env)");
const admin = createPrismaClient(url);

let tenantId: string;

beforeAll(async () => {
  ({ id: tenantId } = await admin.tenant.create({ data: { name: "Teste busca", slug: `teste-busca-${randomUUID()}` } }));
  const menu = await admin.menu.create({ data: { tenantId, name: "Cardápio" } });
  const category = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Pizzas" } });
  await admin.menuItem.createMany({
    data: [
      { tenantId, categoryId: category.id, name: "Calabresa", synonyms: ["calabreza"], ingredients: ["linguiça calabresa", "cebola"] },
      { tenantId, categoryId: category.id, name: "Margherita", ingredients: ["muçarela", "tomate", "manjericão"] },
      { tenantId, categoryId: category.id, name: "Portuguesa", ingredients: ["presunto", "ovo", "ervilha"] },
    ],
  });
});

afterAll(async () => {
  if (tenantId) await admin.tenant.delete({ where: { id: tenantId } });
  await admin.$disconnect();
});

async function search(term: string): Promise<string[]> {
  const rows = await admin.$queryRaw<{ name: string }[]>`
    SELECT name FROM menu_items
    WHERE tenant_id = ${tenantId}::uuid
      AND ${term.toLowerCase()} <% app.menu_item_search_text(name, synonyms, ingredients)
    ORDER BY word_similarity(${term.toLowerCase()}, app.menu_item_search_text(name, synonyms, ingredients)) DESC`;
  return rows.map((row) => row.name);
}

describe("busca do cardápio (pg_trgm)", () => {
  it("acha a calabresa pelo começo do nome, pelo erro de escrita e pelo ingrediente", async () => {
    for (const term of ["calab", "calabreza", "Linguiça"]) {
      expect((await search(term))[0], term).toBe("Calabresa");
    }
  });

  it("não acha item que não tem nada a ver", async () => {
    expect(await search("sushi")).toEqual([]);
  });

  it("a busca usa o índice de trigramas", async () => {
    const indexes = await admin.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'menu_items' AND indexdef LIKE '%gin_trgm_ops%'`;
    expect(indexes.map((i) => i.indexname).sort()).toEqual(["menu_items_name_trgm_idx", "menu_items_search_trgm_idx"]);
  });
});
