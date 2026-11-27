import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createLoginFixture, PASSWORD } from "./fixtures";

let fx: Awaited<ReturnType<typeof createLoginFixture>>;

test.beforeAll(async () => {
  fx = await createLoginFixture();
  // O segundo restaurante (Pizzaria) é o da usuária como administradora: liga o módulo Cardápio nele.
  await fx.db.query(`INSERT INTO tenant_modules (id, tenant_id, module) VALUES ($1, $2, 'MENU'::"ModuleKey")`, [randomUUID(), fx.tenants[1]!.id]);
});

test.afterAll(async () => {
  await fx?.cleanup();
});

test("cadastra categoria e item e marca como esgotado em 1 clique", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(fx.user.email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(fx.tenants[1]!.name) }).click();

  // A entrada só existe com o módulo ligado.
  await page.getByRole("link", { name: "Cardápio", exact: true }).click();
  await expect(page.getByText("Seu cardápio está vazio · 0 itens")).toBeVisible();

  // Categoria pelo caminho "Criar do zero".
  await page.getByRole("button", { name: "Criar categoria" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nome", { exact: true }).fill("Pizzas");
  await dialog.getByRole("button", { name: "Criar categoria" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Pizzas" })).toBeVisible();

  // Item novo: sem preço o editor recusa; com preço salva e volta para a lista.
  await page.getByRole("link", { name: "Novo item" }).first().click();
  await page.getByLabel("Nome", { exact: true }).fill("Calabresa");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Informe o preço");
  await page.getByLabel("Preço", { exact: true }).fill("34,90");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();

  await expect(page.getByText(/1 item\s+· 0 esgotados/)).toBeVisible();
  const row = page.getByTestId("item").filter({ hasText: "Calabresa" });
  await expect(row).toContainText("R$");
  // Avisos colados no item, com a ação ao lado.
  await expect(row.getByText(/Sem foto/)).toBeVisible();
  await expect(row.getByText(/Sem ingredientes/)).toBeVisible();

  await row.getByRole("switch", { name: /marcar como esgotado/ }).click();
  await expect(page.getByText(/1 item\s+· 1 esgotado/)).toBeVisible();
  await expect(row.getByRole("switch")).toContainText("Esgotado");
});
