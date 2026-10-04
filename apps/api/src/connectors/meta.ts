import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Valida o X-Hub-Signature-256: HMAC-SHA256 do corpo bruto com o App Secret da Meta. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = header.slice("sha256=".length);
  return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

const MetaPayload = z.looseObject({
  object: z.string(),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).optional(),
      messaging: z.array(z.unknown()).optional(),
    }),
  ),
});

/** Eventos de um único canal, extraídos de um webhook da Meta. */
export type MetaChannelBatch =
  | { channelType: "WHATSAPP"; externalId: string; value: unknown }
  | { channelType: "INSTAGRAM"; externalId: string; events: unknown[] };

/** Um webhook da Meta pode trazer eventos de vários números/contas: separa por canal. */
export function splitMetaPayload(payload: unknown): MetaChannelBatch[] {
  const parsed = MetaPayload.safeParse(payload);
  if (!parsed.success) return [];
  const batches: MetaChannelBatch[] = [];
  for (const entry of parsed.data.entry) {
    if (parsed.data.object === "whatsapp_business_account") {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = z
          .object({ metadata: z.object({ phone_number_id: z.string() }) })
          .safeParse(change.value);
        if (change.field === "messages" && phoneNumberId.success) {
          batches.push({ channelType: "WHATSAPP", externalId: phoneNumberId.data.metadata.phone_number_id, value: change.value });
        }
      }
    } else if (parsed.data.object === "instagram" && entry.messaging?.length) {
      batches.push({ channelType: "INSTAGRAM", externalId: entry.id, events: entry.messaging });
    }
  }
  return batches;
}
