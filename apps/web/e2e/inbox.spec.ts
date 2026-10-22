import { expect, test } from "@playwright/test";
import { createInboxFixture, PASSWORD, sendWhatsAppWebhook } from "./fixtures";

let fx: Awaited<ReturnType<typeof createInboxFixture>>;

test.beforeAll(async () => {
  fx = await createInboxFixture();
});

test.afterAll(async () => {
  await fx?.cleanup();
});

test("atende uma conversa do WhatsApp de ponta a ponta", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(fx.user.email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(fx.tenants[0]!.name) }).click();

  // Lista: cliente, prévia e não lida.
  const row = page.getByRole("button", { name: new RegExp(fx.contact.name) });
  await expect(row).toContainText("Olá, vocês entregam hoje?");
  await row.click();

  // Conversa e painel do cliente.
  await expect(page.locator("header").getByText(fx.contact.name)).toBeVisible();
  await expect(page.getByText("(11) 95555-0000").first()).toBeVisible();
  await expect(page.getByText(/Janela de 24h/)).toHaveCount(0); // WhatsApp por QR Code: sem janela de 24h

  // Resposta rápida com "/".
  const composer = page.getByLabel("Mensagem para o cliente");
  await composer.fill("/atr");
  await expect(page.getByRole("option", { name: /\/atraso/ })).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveValue("Peço desculpas pela demora! Já estou verificando.");

  // Envio (modo de simulação): a mensagem aparece e é confirmada pelo worker.
  const timeline = page.getByRole("log", { name: "Mensagens da conversa" });
  await page.getByRole("button", { name: "Enviar" }).click();
  const sent = timeline.getByText("Peço desculpas pela demora! Já estou verificando.");
  await expect(sent).toBeVisible();
  await expect(composer).toHaveValue("");

  // Nota interna.
  await page.getByRole("tab", { name: "Nota interna" }).click();
  await page.getByLabel("Nota interna para a equipe").fill("Cliente pediu entrega rápida");
  await page.getByRole("button", { name: "Salvar nota" }).click();
  await expect(timeline.getByText("Cliente pediu entrega rápida")).toBeVisible();
  await expect(timeline.getByText(/Nota interna — Bruna/)).toBeVisible();

  // Realtime: o cliente escreve de novo e a mensagem aparece sem recarregar.
  await sendWhatsAppWebhook(fx.channel.externalId, fx.contact.waId, "Obrigada, aguardo!");
  await expect(timeline.getByText("Obrigada, aguardo!")).toBeVisible({ timeout: 10_000 });
  // Chegou depois da nota: aparece abaixo dela, mesmo dentro do mesmo segundo.
  const note = await timeline.getByText("Cliente pediu entrega rápida").boundingBox();
  const reply = await timeline.getByText("Obrigada, aguardo!").boundingBox();
  expect(reply!.y).toBeGreaterThan(note!.y);
  await page.screenshot({ path: "test-results/inbox.png" });

  // Resolver: sai dos ativos e a conversa seguinte da lista abre.
  await page.getByRole("button", { name: "Resolver" }).click();
  await expect(page.locator("header").getByText(fx.closedContact.name)).toBeVisible();
  await expect(row).toHaveCount(0);

  // Conversa parada há dois dias (a que o Resolver abriu): pelo QR Code não há janela de 24h, a resposta é livre.
  await expect(page.getByText(/A janela de 24h terminou/)).toHaveCount(0);
  await page.getByLabel("Mensagem para o cliente").fill("Oi, Carla! Podemos continuar?");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(timeline.getByText("Oi, Carla! Podemos continuar?")).toBeVisible();
});
