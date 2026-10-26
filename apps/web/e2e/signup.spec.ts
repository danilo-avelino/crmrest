import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { PASSWORD } from "./fixtures";

const suffix = randomUUID().slice(0, 8);
const emails = { first: `cadastro-${suffix}@teste.local`, repeated: `repetido-${suffix}@teste.local` };
const TENANTS_OF_USER = "SELECT m.tenant_id FROM tenant_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1";
// Restaurante de um teste grátis que acabou há 10 dias, com uma loja do iFood conectada.
const oldTrial = { id: randomUUID(), merchantId: randomUUID() };
let db: pg.Client;

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await db.connect();
  await db.query("INSERT INTO tenants (id, name, slug, trial_ends_at) VALUES ($1, $2, $3, now() - interval '10 days')", [
    oldTrial.id,
    `Teste Antigo ${suffix}`,
    `teste-antigo-${suffix}`,
  ]);
  await db.query(
    `INSERT INTO channels (id, tenant_id, type, name, external_id, credentials, status) VALUES ($1, $2, 'IFOOD', 'Loja', $3, ''::bytea, 'CONNECTED')`,
    [randomUUID(), oldTrial.id, oldTrial.merchantId],
  );
});

test.afterAll(async () => {
  for (const email of Object.values(emails)) {
    await db.query(`DELETE FROM tenants WHERE id IN (${TENANTS_OF_USER})`, [email]);
    await db.query("DELETE FROM users WHERE email = $1", [email]);
  }
  await db.query("DELETE FROM tenants WHERE id = $1", [oldTrial.id]);
  await db.end();
});

async function fillSignup(page: Page, restaurant: string, email: string, taxId: string) {
  await page.getByLabel("Nome do restaurante").fill(restaurant);
  await page.getByLabel("Seu nome").fill("Bruna Teste");
  await page.getByLabel("WhatsApp").fill("(86) 99817-9385");
  await page.getByLabel("CPF ou CNPJ").fill(taxId);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta e começar o teste" }).click();
}

test("cadastro pelo site entra na Inbox em teste; com o teste encerrado, cai na tela de pagamento", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Testar grátis por 15 dias" }).first().click();
  // Espera a página carregar (como o goto): digitar antes de o React assumir o formulário perde o que foi digitado.
  await page.waitForURL(/\/cadastro$/);
  await expect(page.getByRole("heading", { name: "Teste grátis por 15 dias" })).toBeVisible();

  await fillSignup(page, `Cantina E2E ${suffix}`, emails.first, "123.456.789-00");
  // O Next também tem um role="alert" (anunciador de rotas): filtra pelo texto.
  await expect(page.getByRole("alert").filter({ hasText: "Informe um CPF ou CNPJ válido." })).toBeVisible();
  await page.screenshot({ path: "test-results/cadastro.png" });

  await page.getByLabel("CPF ou CNPJ").fill("123.456.789-09");
  await page.getByRole("button", { name: "Criar conta e começar o teste" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  // O teste acaba: no próximo carregamento o restaurante não entra mais e a tela de pagamento aparece.
  await db.query(`UPDATE tenants SET trial_ends_at = now() - interval '1 minute' WHERE id IN (${TENANTS_OF_USER})`, [emails.first]);
  await page.reload();
  await expect(page).toHaveURL(/\/assinatura$/);
  await expect(page.getByRole("heading", { name: "Seu teste grátis acabou" })).toBeVisible();
  await expect(page.getByText(`Cantina E2E ${suffix}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Pagar o plano anual" })).toBeVisible();
  await page.screenshot({ path: "test-results/assinatura.png" });

  // Sem a chave da Stripe (ambiente de teste), o botão chega à API e mostra a resposta dela.
  await page.getByRole("button", { name: "Assinar no cartão" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "O pagamento ainda não está disponível. Fale com a gente." })).toBeVisible();

  // Assinatura vencida: a tela avisa do pagamento pendente e o acesso é liberado por confiança, uma vez.
  await db.query(`UPDATE tenants SET paid_until = now() - interval '1 hour', billing_plan = 'MONTHLY' WHERE id IN (${TENANTS_OF_USER})`, [
    emails.first,
  ]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pagamento pendente" })).toBeVisible();
  await page.screenshot({ path: "test-results/pagamento-pendente.png" });
  await page.getByRole("button", { name: "Liberar acesso por confiança" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("status").filter({ hasText: "Avise ao financeiro para concluir o pagamento. 3 dias restantes." })).toBeVisible();
  await page.screenshot({ path: "test-results/lembrete-confianca.png" });

  await page.getByRole("link", { name: "Concluir pagamento" }).click();
  await expect(page).toHaveURL(/\/configuracoes\/pagamento$/);
  await expect(page.getByText("O acesso está liberado por confiança até")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cadastrar novo cartão" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gerar plano anual" })).toBeVisible();
  await page.screenshot({ path: "test-results/aba-pagamento.png" });
});

test("conectar um canal que já passou por outro teste grátis encerra o teste e leva à tela de pagamento", async ({ page }) => {
  await page.goto("/cadastro");
  await fillSignup(page, `Cantina Repetida ${suffix}`, emails.repeated, "123.456.789-09");
  // No primeiro acesso a Inbox abre o assistente sozinho: a corrida entre os dois destinos não importa aqui.
  await expect(page).toHaveURL(/\/(inbox|assistente)/);

  await page.goto("/configuracoes/integracoes");
  await page.locator("section", { has: page.locator("#integracao-IFOOD") }).getByRole("button", { name: "Conectar" }).click();
  await page.getByLabel("ID da loja (merchant ID)").fill(oldTrial.merchantId);
  await page.getByRole("dialog").getByRole("button", { name: "Conectar", exact: true }).click();

  await expect(page).toHaveURL(/\/assinatura\?restaurante=/);
  await expect(page.getByRole("heading", { name: "Este teste grátis já foi usado" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "já passou por um teste grátis nos últimos 60 dias" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Assinar no cartão" })).toBeVisible();
  await page.screenshot({ path: "test-results/teste-repetido.png" });

  // O bloqueio fica gravado: entrar de novo cai na mesma tela.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/assinatura$/);
  await expect(page.getByRole("heading", { name: "Este teste grátis já foi usado" })).toBeVisible();
});
