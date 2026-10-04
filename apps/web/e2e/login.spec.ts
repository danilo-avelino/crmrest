import { expect, type Page, test } from "@playwright/test";
import { createLoginFixture, PASSWORD } from "./fixtures";

let fx: Awaited<ReturnType<typeof createLoginFixture>>;

test.beforeAll(async () => {
  fx = await createLoginFixture();
});

test.afterAll(async () => {
  await fx?.cleanup();
});

async function fillLogin(page: Page, password: string) {
  await page.getByLabel("E-mail").fill(fx.user.email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

test("senha errada mostra o erro na própria tela", async ({ page }) => {
  await page.goto("/login");
  await fillLogin(page, "senha-errada");
  // O Next também tem um role="alert" (anunciador de rotas): filtra pelo texto.
  await expect(page.getByRole("alert").filter({ hasText: "E-mail ou senha inválidos." })).toBeVisible();
});

test("login, escolha do restaurante, reload mantém a sessão e logout volta ao login", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/login$/);

  await fillLogin(page, PASSWORD);
  await expect(page.getByRole("heading", { name: "Escolha o restaurante" })).toBeVisible();
  await expect(page.getByText("Você tem acesso a 2 espaços.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Painel master/ })).toBeVisible();
  await page.screenshot({ path: "test-results/login-escolha.png" });

  const [trattoria] = fx.tenants;
  await page.getByRole("button", { name: new RegExp(trattoria!.name) }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  await page.getByRole("button", { name: "Conta" }).click();
  await expect(page.getByRole("menu")).toContainText(trattoria!.name);
  await page.getByRole("menuitem", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("painel master entra com todos os restaurantes", async ({ page }) => {
  await page.goto("/login");
  await fillLogin(page, PASSWORD);
  await page.getByRole("button", { name: /Painel master/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  // No master, a lista pode ser filtrada por restaurante.
  await expect(page.getByRole("button", { name: "Filtrar por restaurante" })).toBeVisible();
});
