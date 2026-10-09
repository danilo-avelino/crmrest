import { z } from "zod";

// Painel da plataforma (Super Admin, E16): restaurantes, uso e auditoria.

/** Restaurante como aparece na lista da plataforma, com o uso de cada um. */
export type PlatformTenantDto = {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  activeMembers: number;
  connectedChannels: number;
  openConversations: number;
  /** Mensagens (recebidas e enviadas) nos últimos 30 dias. */
  messagesLast30Days: number;
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Novo restaurante já com o primeiro administrador (quem já tem conta mantém a senha atual). */
export const CreateTenantRequest = z.object({
  name: z.string().trim().min(1, "Informe o nome do restaurante.").max(80, "Use até 80 caracteres."),
  slug: z
    .string()
    .trim()
    .min(2, "Use pelo menos 2 caracteres.")
    .max(60, "Use até 60 caracteres.")
    .regex(SLUG_PATTERN, "Use só letras minúsculas, números e hífen."),
  adminName: z.string().trim().min(1, "Informe o nome do administrador.").max(80, "Use até 80 caracteres."),
  adminEmail: z.email({ error: "Informe um e-mail válido." }).transform((email) => email.toLowerCase()),
  adminPassword: z.string().min(8, "Use pelo menos 8 caracteres.").max(128, "Use até 128 caracteres."),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const UpdateTenantStatusRequest = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) });
export type UpdateTenantStatusRequest = z.infer<typeof UpdateTenantStatusRequest>;

/** Ação da plataforma registrada na auditoria (criação, suspensão, acesso de suporte). */
export type PlatformAuditDto = {
  id: string;
  action: "tenant.create" | "tenant.suspend" | "tenant.reactivate" | "tenant.support_access";
  userName: string | null;
  tenantId: string | null;
  tenantName: string | null;
  createdAt: string;
};

/** "Grupo Moby Dick" → "grupo-moby-dick". */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}
