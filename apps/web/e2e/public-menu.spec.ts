import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { createLoginFixture } from "./fixtures";

// F3-10: o cardápio público em 360 px (celular, navegador do WhatsApp) e 1280 px (desktop): nada passa da largura da
// tela, o fluxo item → sacola → checkout funciona e os cartões Entrega/Retirada não se sobrepõem (R13).

let fx: Awaited<ReturnType<typeof createLoginFixture>>;
let slug = "";

test.beforeAll(async () => {
  fx = await createLoginFixture();
  const tenant = fx.tenants[1]!;
  slug = tenant.slug;
  const q = (sql: string, params: unknown[]) => fx.db.query(sql, params);
  await q(`INSERT INTO tenant_modules (id, tenant_id, module) VALUES ($1, $2, 'MENU'::"ModuleKey")`, [randomUUID(), tenant.id]);
  await q(`UPDATE tenants SET settings = $2::jsonb WHERE id = $1`, [
    tenant.id,
    JSON.stringify({
      menuStore: {
        address: { street: "Rua da Loja", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "" },
        pickupEnabled: true,
        prepMinutes: 20,
        delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 500 }] },
        minOrderCents: 0,
        deliveryMinMinutes: 30,
        deliveryMaxMinutes: 50,
        paymentMethods: ["cash", "credit"],
        scheduling: { enabled: false, minLeadMinutes: 30, slotMinutes: 30 },
        promoShowcase: { itemIds: [], frequencyHours: 24 },
      },
    }),
  ]);
  const menu = randomUUID();
  const category = randomUUID();
  const item = randomUUID();
  await q(`INSERT INTO menus (id, tenant_id, name, updated_at) VALUES ($1, $2, 'Cardápio', now())`, [menu, tenant.id]);
  await q(`INSERT INTO menu_categories (id, tenant_id, menu_id, name, sort_order) VALUES ($1, $2, $3, 'Pizzas com um nome de categoria bem comprido', 0)`, [category, tenant.id, menu]);
  await q(
    `INSERT INTO menu_items (id, tenant_id, category_id, name, description, sort_order, updated_at) VALUES ($1, $2, $3, 'Calabresa artesanal com cebola roxa e azeitonas pretas', 'Molho de tomate, muçarela, calabresa fatiada fininha, cebola roxa e azeitonas pretas.', 0, now())`,
    [item, tenant.id, category],
  );
  await q(`INSERT INTO menu_item_sizes (id, tenant_id, item_id, name, price_cents, sort_order) VALUES ($1, $2, $3, 'Grande', 5990, 0)`, [randomUUID(), tenant.id, item]);
});

test.afterAll(async () => {
  await fx?.cleanup();
});

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "a página não pode rolar para o lado").toBeLessThanOrEqual(0);
}

for (const viewport of [
  { name: "celular 360 px", width: 360, height: 760 },
  { name: "desktop 1280 px", width: 1280, height: 800 },
]) {
  test(`cardápio, ficha, sacola e checkout · ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/c/${slug}`);
    await expect(page.getByText("Calabresa artesanal", { exact: false }).first()).toBeVisible();
    await noHorizontalScroll(page);

    await page.getByText("Calabresa artesanal", { exact: false }).first().click();
    await page.getByText("Grande", { exact: true }).first().click();
    const add = page.getByRole("button", { name: /^Adicionar ·/ });
    await expect(add).toContainText("59,90");
    await add.click();
    await noHorizontalScroll(page);

    // Sacola: no celular pela barra fixa; no desktop a coluna lateral já está aberta.
    if (viewport.width < 1024) await page.getByRole("button", { name: /Ver sacola/ }).click();
    await page.getByRole("button", { name: /^Continuar/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/c/${slug}/checkout`));
    await noHorizontalScroll(page);

    // Identificação: segue como visitante para chegar ao passo Entrega.
    await page.getByRole("button", { name: /sem salvar/i }).click();
    await page.getByLabel(/nome/i).first().fill("Visitante E2E");
    await page.getByLabel(/celular|telefone/i).first().fill("11 98888-7777");
    await page.getByRole("button", { name: /Continuar/ }).first().click();

    // R13: os cartões Entrega e Retirada não se sobrepõem.
    const delivery = await page.getByRole("radio", { name: /Entrega/ }).first().boundingBox();
    const pickup = await page.getByRole("radio", { name: /Retirada/ }).first().boundingBox();
    expect(delivery && pickup).toBeTruthy();
    const overlap = !(delivery!.x + delivery!.width <= pickup!.x || pickup!.x + pickup!.width <= delivery!.x || delivery!.y + delivery!.height <= pickup!.y || pickup!.y + pickup!.height <= delivery!.y);
    expect(overlap, "Entrega e Retirada sobrepostos").toBe(false);
    await noHorizontalScroll(page);
  });
}
