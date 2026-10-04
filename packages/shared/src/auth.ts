import type { TenantRole } from "@comanda/database/enums";
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

export type AuthUser = { id: string; name: string; email: string };

/** Restaurante em que o usuário tem acesso, como aparece na tela "Escolha o restaurante". */
export type AuthTenant = { id: string; name: string; slug: string; role: TenantRole; openConversations: number };

export type AuthContext = { mode: "tenant" | "master"; tenants: { id: string; name: string; role: TenantRole }[] };

/** Resposta de login, escolha de contexto e refresh. Sem contexto escolhido, não há access token. */
export type AuthSession = {
  user: AuthUser;
  tenants: AuthTenant[];
  context: AuthContext | null;
  accessToken: string | null;
};
