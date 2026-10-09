import type { TenantRole } from "@dishdesk/database/enums";
import { z } from "zod";

export const LoginRequest = z.object({
  email: z.email().transform((email) => email.toLowerCase()),
  password: z.string().min(1),
});
export type LoginRequest = z.input<typeof LoginRequest>;

/** Depois do login: um restaurante ou o painel master (todos os restaurantes do usuário, §5.1.1). */
export const SelectContextRequest = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant"), tenantId: z.uuid() }),
  z.object({ mode: z.literal("master") }),
]);
export type SelectContextRequest = z.infer<typeof SelectContextRequest>;

/** isSuperAdmin: equipe da plataforma (painel Super Admin, E16). */
export type AuthUser = { id: string; name: string; email: string; isSuperAdmin: boolean };

/** Restaurante em que o usuário tem acesso, como aparece na tela "Escolha o restaurante". */
export type AuthTenant = { id: string; name: string; slug: string; role: TenantRole; openConversations: number };

/** support: super admin num restaurante de que não é membro (acesso de suporte, auditado); age como admin. */
export type AuthContext = {
  mode: "tenant" | "master";
  tenants: { id: string; name: string; role: TenantRole }[];
  support?: boolean;
};

/** Resposta de login, escolha de contexto e refresh. Sem contexto escolhido, não há access token. */
export type AuthSession = {
  user: AuthUser;
  tenants: AuthTenant[];
  context: AuthContext | null;
  accessToken: string | null;
};
