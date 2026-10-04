import { ChannelType, Direction, MessageStatus, MessageType } from "@comanda/database/enums";
import { z } from "zod";

// Contratos que atravessam as filas como JSON (PROJETO_CRM_RESTAURANTES.md §3.5 e §6).
// Os enums vêm do schema do banco, então os valores são os mesmos gravados nas tabelas.
// As datas usam coerce porque chegam como string depois da serialização na fila.

/** Mensagem de qualquer canal no formato interno, produzida pelo conector após resolver o canal. */
export const NormalizedMessage = z.object({
  channelId: z.uuid(),
  channelType: z.enum(ChannelType),
  externalMessageId: z.string().min(1),
  externalContactId: z.string().min(1), // wa_id, IGSID, id do cliente/pedido iFood...
  direction: z.enum(Direction).exclude(["INTERNAL"]), // notas e eventos internos não vêm de canais
  type: z.enum(MessageType).exclude(["NOTE"]),
  text: z.string().optional(),
  media: z
    .object({
      url: z.url().optional(),
      mimeType: z.string(),
      externalMediaId: z.string().optional(),
    })
    .optional(),
  // Tudo o que a origem conseguir fornecer, já normalizado: o conector omite valores fora do formato.
  contactProfile: z
    .object({
      name: z.string().optional(),
      phone: z.e164().optional(),
      cpf: z.string().regex(/^\d{11}$/).optional(), // só dígitos
      email: z.email().optional(),
      avatarUrl: z.url().optional(),
      address: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(), // ex.: orderId do iFood
  timestamp: z.coerce.date(),
});
export type NormalizedMessage = z.infer<typeof NormalizedMessage>;

/** Mudança de status de uma mensagem enviada, informada pelo canal via webhook. */
export const StatusUpdate = z.object({
  channelId: z.uuid(),
  channelType: z.enum(ChannelType),
  externalMessageId: z.string().min(1),
  status: z.enum(MessageStatus).exclude(["PENDING"]), // PENDING é interno: ainda não foi enviada
  error: z.string().optional(),
  timestamp: z.coerce.date(),
});
export type StatusUpdate = z.infer<typeof StatusUpdate>;
