import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import type { CustomerHistory } from "./orders.js";
import { ChannelType as ChannelTypeEnum } from "@dishdesk/database/enums";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { z } from "zod";

/** Telefone digitado ou informado pelo cliente → E.164 (Brasil como padrão), ou null se inválido. */
export function toE164(input: string): string | null {
  const phone = parsePhoneNumberFromString(input, "BR");
  return phone?.isValid() ? phone.number : null;
}

/**
 * wa_id do WhatsApp → telefone E.164. Celulares brasileiros cadastrados antes do 9º dígito vêm sem o 9
 * ("558699731647"); o telefone é sempre o atual, com o 9 ("+5586999731647"), como chega dos outros canais.
 */
export function phoneFromWhatsAppId(waId: string): string {
  const legacyMobile = /^55(\d{2})([6-9]\d{7})$/.exec(waId);
  return legacyMobile ? `+55${legacyMobile[1]}9${legacyMobile[2]}` : `+${waId}`;
}

/** "+5511976543210" → "(11) 97654-3210"; números de fora do Brasil no formato internacional. */
export function formatPhone(e164: string): string {
  const phone = parsePhoneNumberFromString(e164);
  if (!phone) return e164;
  return phone.country === "BR" ? phone.formatNational() : phone.formatInternational();
}

/** CPF com os dígitos verificadores corretos (só dígitos). */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

/** Exibição mascarada (§8): "***.456.789-**". */
export function maskCpf(digits: string): string {
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

export type ContactOrderSummary = {
  id: string;
  displayCode: string | null;
  status: OrderStatus;
  total: string;
  placedAt: string;
};

export type ContactDetail = {
  id: string;
  tenantId: string;
  name: string | null;
  phone: string | null;
  phoneSource: string | null;
  phoneStatus: string | null;
  email: string | null;
  cpfMasked: string | null;
  notes: string | null;
  tags: string[];
  firstSeenAt: string;
  identities: { channelType: ChannelType; externalId: string; username: string | null }[];
  addresses: {
    id: string;
    label: string | null;
    street: string;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string;
    state: string;
    zipCode: string | null;
  }[];
  /** Pedidos em todas as fontes ligadas ao cliente (mesmo telefone, CPF ou e-mail), sem os cancelados. */
  metrics: { ordersCount: number; ordersTotal: string; ordersBySource: CustomerHistory["bySource"] };
  recentOrders: ContactOrderSummary[];
  lastSeenAt: string | null;
  conversationsCount: number;
  /** Conversa mais recente (botão "Abrir conversa"). */
  latestConversationId: string | null;
  /** Dados pessoais removidos (LGPD): quando e por quem. */
  anonymized: { at: string; by: string | null } | null;
};

/** Filtro "Último contato" da lista de clientes: dentro dos últimos N dias, ou sem contato há mais de N dias. */
export const LAST_CONTACT_FILTERS = ["7d", "30d", "over30d", "over60d", "over90d"] as const;
export type LastContactFilter = (typeof LAST_CONTACT_FILTERS)[number];

export const CONTACT_SORTS = ["lastSeen", "name", "phone", "orders"] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];

export const CONTACT_PAGE_SIZE = 50;

/** Parâmetro repetido na query string (?tag=VIP&tag=recorrente); um só chega como string. */
const queryList = <T extends z.ZodType>(item: T) =>
  z.preprocess((value) => (value === undefined || Array.isArray(value) ? value : [value]), z.array(item).max(20).optional());

export const ContactListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  tag: queryList(z.string().trim().min(1).max(40)),
  channel: queryList(z.enum(ChannelTypeEnum)),
  district: z.string().trim().min(1).max(100).optional(),
  phonePending: z.stringbool().optional(),
  /** Chateados: o último pedido foi cancelado. */
  upset: z.stringbool().optional(),
  lastContact: z.enum(LAST_CONTACT_FILTERS).optional(),
  sort: z.enum(CONTACT_SORTS).default("lastSeen"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type ContactListQuery = z.infer<typeof ContactListQuery>;

/** Linha da lista de clientes (no painel master, `tenant` diz de qual restaurante é). */
export type ContactListItem = {
  id: string;
  tenant: { id: string; name: string };
  name: string | null;
  tags: string[];
  phone: string | null;
  phoneStatus: string | null;
  channels: ChannelType[];
  district: string | null;
  ordersCount: number;
  ordersTotal: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  anonymizedAt: string | null;
};

export type ContactPage = { items: ContactListItem[]; total: number; page: number; pageSize: number };

/** Opções dos filtros Tag e Bairro: o que existe nos cadastros. */
export type ContactFilterOptions = { tags: string[]; districts: string[] };

/** Inativo: sem contato há mais de tantos dias (o mesmo corte do filtro "Último contato"). */
export const INACTIVE_AFTER_DAYS = 30;

/** Números da base de clientes, acima da lista (sem anonimizados; pedidos cancelados não contam). */
export type ContactSummary = {
  total: number;
  /** Primeiro contato nos últimos 30 dias. */
  newLast30d: number;
  /** Com a tag VIP. */
  vip: number;
  /** Dois pedidos ou mais. */
  recurring: number;
  inactive: number;
  /** Chateados: o último pedido foi cancelado. */
  upset: number;
  phonePending: number;
  /** Fazem aniversário no mês atual. */
  birthdaysThisMonth: number;
  orders: number;
  /** Ticket médio dos pedidos, em reais (string decimal); null sem pedidos. */
  averageTicket: string | null;
};

/** Por que dois cadastros parecem ser da mesma pessoa. */
export type DuplicateReason = "phone" | "cpf" | "email" | "name" | "address";

export type DuplicateSide = {
  id: string;
  name: string | null;
  phone: string | null;
  tags: string[];
  channels: ChannelType[];
  /** Endereços como "rua|número" normalizados: os repetidos não passam na união. */
  addressKeys: string[];
  ordersCount: number;
  conversationsCount: number;
  firstSeenAt: string;
};

/** Par da fila de possíveis duplicados (só admin). Na união fica `keep`, o cadastro mais antigo. */
export type DuplicatePair = { tenantId: string; reasons: DuplicateReason[]; keep: DuplicateSide; other: DuplicateSide };

export const ContactPairRequest = z.object({ contactIds: z.tuple([z.uuid(), z.uuid()]) });
export type ContactPairRequest = z.infer<typeof ContactPairRequest>;

export const UpdateContactRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.e164().nullable().optional(),
  email: z.email().nullable().optional(),
  cpf: z.string().refine(isValidCpf, "CPF inválido.").nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateContactRequest = z.infer<typeof UpdateContactRequest>;
