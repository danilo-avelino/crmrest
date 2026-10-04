// Simula uma mensagem recebida pelo WhatsApp, assinada como a Meta faria (só desenvolvimento).
// Uso: pnpm simulate:whatsapp --texto "Olá!" [--de 5511999990000] [--nome "Cliente"] [--canal dev-cantina-da-nonna-whatsapp]
import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { values } = parseArgs({
  options: {
    texto: { type: "string", default: "Olá! Vocês estão abertos?" },
    de: { type: "string", default: "5511999990000" },
    nome: { type: "string", default: "Cliente Simulado" },
    canal: { type: "string", default: "dev-cantina-da-nonna-whatsapp" },
    url: { type: "string", default: `http://localhost:${process.env.PORT ?? 4000}/api/webhooks/meta` },
  },
});

const secret = process.env.META_APP_SECRET;
if (!secret) throw new Error("META_APP_SECRET não definido no .env");

const raw = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA-DEV",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "5511", phone_number_id: values.canal },
            contacts: [{ profile: { name: values.nome }, wa_id: values.de }],
            messages: [
              {
                from: values.de,
                id: `wamid.SIM-${randomUUID()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: values.texto },
              },
            ],
          },
        },
      ],
    },
  ],
});

const response = await fetch(values.url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
  },
  body: raw,
});
console.log(`${response.status} ${await response.text()}`);
