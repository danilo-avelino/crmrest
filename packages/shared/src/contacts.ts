import type { ChannelType, OrderStatus } from "@comanda/database/enums";
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
  metrics: { ordersCount: number; ordersTotal: string };
  recentOrders: ContactOrderSummary[];
};

export const UpdateContactRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.e164().nullable().optional(),
  email: z.email().nullable().optional(),
  cpf: z.string().refine(isValidCpf, "CPF inválido.").nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateContactRequest = z.infer<typeof UpdateContactRequest>;
