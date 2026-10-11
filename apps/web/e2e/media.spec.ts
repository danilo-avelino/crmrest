import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { createInboxFixture, PASSWORD } from "./fixtures";

// O que a plataforma serviria: um PNG de 1 pixel e meio segundo de silêncio em WAV (8 kHz, 8 bits, mono).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const WAV = (() => {
  const samples = Buffer.alloc(4000, 128);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
})();
const FILES: Record<string, [type: string, body: Buffer]> = { "/foto.png": ["image/png", PNG], "/audio.wav": ["audio/wav", WAV] };

let fx: Awaited<ReturnType<typeof createInboxFixture>>;
let cdn: Server;

test.beforeAll(async () => {
  // Faz o papel do endereço de mídia que o Instagram manda no webhook; "/apagada.png" já não existe.
  cdn = createServer((req, res) => {
    const file = FILES[req.url ?? ""];
    if (!file) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file[0] }).end(file[1]);
  });
  await new Promise<void>((resolve) => cdn.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;

  fx = await createInboxFixture();
  const media = [
    ["IMAGE", { text: "Veio assim", media: { mimeType: "image/*", url: `${origin}/foto.png` } }],
    ["AUDIO", { media: { mimeType: "audio/*", url: `${origin}/audio.wav` } }],
    ["IMAGE", { media: { mimeType: "image/*", url: `${origin}/apagada.png` } }],
  ] as const;
  for (const [index, [type, content]] of media.entries()) {
    await fx.db.query(
      `INSERT INTO messages (id, tenant_id, conversation_id, channel_id, external_message_id, direction, type, content, status, created_at)
       SELECT $1, tenant_id, id, channel_id, $2, 'INBOUND', $3::"MessageType", $4, 'DELIVERED', now() + $5 * interval '1 second'
       FROM conversations WHERE contact_id = $6`,
      [randomUUID(), `mid.E2E-${fx.suffix}-${index}`, type, content, index + 1, fx.contact.id],
    );
  }
});

test.afterAll(async () => {
  await fx?.cleanup();
  cdn?.close();
});

test("mostra a imagem e toca o áudio que o cliente mandou", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(fx.user.email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(fx.tenants[0]!.name) }).click();
  await page.getByRole("button", { name: new RegExp(fx.contact.name) }).click();

  const timeline = page.getByRole("log", { name: "Mensagens da conversa" });
  await expect(timeline.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await expect(timeline.getByText("Veio assim")).toBeVisible();
  await expect.poll(() => timeline.locator("audio").evaluate((audio: HTMLAudioElement) => audio.duration)).toBeCloseTo(0.5, 1);
  // Arquivo que a plataforma já apagou.
  await expect(timeline.getByText("Imagem · não está mais disponível")).toBeVisible();
  await page.screenshot({ path: "test-results/media.png" });

  await timeline.getByRole("button", { name: "Ampliar imagem" }).click();
  await expect(page.getByRole("dialog").locator("img")).toHaveJSProperty("naturalWidth", 1);
});
