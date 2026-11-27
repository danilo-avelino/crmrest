import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createLoginFixture } from "./fixtures";

// Q-01: pedido com Pix do começo ao fim no navegador. A Pagar.me não roda no dev, então a cobrança e a confirmação
// são simuladas na rede (POST /orders devolve o Pix; GET /payments responde pendente e depois pago). O resto é real:
// cardápio, sacola, checkout, CPF, QR, contador, consulta e a tela do pedido.

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
        paymentMethods: ["pix", "cash"],
        pixRecipientId: "re_e2epix12345",
        scheduling: { enabled: false, minLeadMinutes: 30, slotMinutes: 30 },
      },
    }),
  ]);
  const menu = randomUUID();
  const category = randomUUID();
  const item = randomUUID();
  await q(`INSERT INTO menus (id, tenant_id, name, updated_at) VALUES ($1, $2, 'Cardápio', now())`, [menu, tenant.id]);
  await q(`INSERT INTO menu_categories (id, tenant_id, menu_id, name, sort_order) VALUES ($1, $2, $3, 'Pizzas', 0)`, [category, tenant.id, menu]);
  await q(`INSERT INTO menu_items (id, tenant_id, category_id, name, sort_order, updated_at) VALUES ($1, $2, $3, 'Calabresa', 0, now())`, [item, tenant.id, category]);
  await q(`INSERT INTO menu_item_sizes (id, tenant_id, item_id, name, price_cents, sort_order) VALUES ($1, $2, $3, 'Grande', 5000, 0)`, [randomUUID(), tenant.id, item]);
});

test.afterAll(async () => {
  await fx?.cleanup();
});

test("Pix: CPF, QR com copia e cola, pagamento confirmado e a tela do pedido", async ({ page }) => {
  const paymentId = randomUUID();
  const orderId = randomUUID();
  let polls = 0;
  let sent: { payment?: { method?: string; cpf?: string } } = {};
  await page.route(`**/api/public/menu/${slug}/orders`, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      json: { kind: "pix", paymentId, token: "tok", qrCode: "00020126PIXE2E", qrCodeUrl: null, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), amountCents: 5000 },
    });
  });
  await page.route(`**/api/public/menu/${slug}/payments/${paymentId}`, async (route) => {
    polls++;
    const paid = polls >= 2;
    await route.fulfill({
      json: {
        status: paid ? "PAID" : "PENDING",
        amountCents: 5000,
        qrCode: paid ? null : "00020126PIXE2E",
        qrCodeUrl: null,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        orderId: paid ? orderId : null,
        orderToken: paid ? "order-tok" : null,
      },
    });
  });
  await page.route(`**/api/public/menu/${slug}/orders/${orderId}`, async (route) => {
    await route.fulfill({
      json: {
        id: orderId,
        code: "1001",
        status: "CONFIRMED",
        placedAt: new Date().toISOString(),
        scheduledFor: null,
        mode: "PICKUP",
        eta: { minMinutes: 20, maxMinutes: 20 },
        address: null,
        items: [{ name: "Calabresa (Grande)", quantity: 1, totalCents: 5000, options: [], notes: null }],
        subtotalCents: 5000,
        deliveryFeeCents: 0,
        totalCents: 5000,
        payment: { method: "pix", changeForCents: null },
        notes: null,
        storePhone: null,
        timeline: [{ code: "CONFIRMED", at: new Date().toISOString() }],
        rating: null,
        reorder: [],
      },
    });
  });

  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto(`/c/${slug}`);
  await page.getByText("Calabresa", { exact: false }).first().click();
  await page.getByText("Grande", { exact: true }).first().click();
  await page.getByRole("button", { name: /^Adicionar ·/ }).click();
  await page.getByRole("button", { name: /Ver sacola/ }).click();
  await page.getByRole("button", { name: /^Continuar/ }).first().click();

  await page.getByRole("button", { name: /sem salvar/i }).click();
  await page.getByLabel(/nome/i).first().fill("Visitante Pix");
  await page.getByLabel(/celular|telefone/i).first().fill("11 98888-7777");
  await page.getByRole("button", { name: /Continuar/ }).first().click();
  await page.getByRole("radio", { name: /Retirada/ }).first().click();
  await page.getByRole("button", { name: /Continuar|pagamento/i }).last().click();

  await expect(page).toHaveURL(new RegExp(`/c/${slug}/checkout/pagamento`));
  await page.getByRole("radio", { name: /^Pix/ }).click();
  await page.getByRole("button", { name: "Revisar pedido" }).click();
  await expect(page.getByText("Informe um CPF válido para o Pix.")).toBeVisible();
  await page.getByLabel("CPF de quem paga").fill("52998224725");
  await expect(page.getByLabel("CPF de quem paga")).toHaveValue("529.982.247-25");
  await page.getByRole("button", { name: "Revisar pedido" }).click();
  await page.getByRole("button", { name: /Pagar com Pix/ }).click();

  await expect(page.getByText("00020126PIXE2E")).toBeVisible();
  await expect(page.getByText(/vence em \d{2}:\d{2}/)).toBeVisible();
  expect(sent.payment).toEqual({ method: "pix", changeForCents: null, cpf: "52998224725" });

  // Pago na fonte: a tela abre o acompanhamento sozinha.
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/pedido/${orderId}`), { timeout: 15_000 });
  await expect(page.getByText("Pago com Pix").first()).toBeVisible();
});
