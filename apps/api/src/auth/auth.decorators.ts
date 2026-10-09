import type { TenantScope } from "@dishdesk/database";
import type { TenantRole } from "@dishdesk/database/enums";
import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";

/** Rota sem login (health, login, webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Quem fez a requisição, extraído do access token. */
export type RequestAuth = {
  userId: string;
  mode: "tenant" | "master";
  tenants: { id: string; role: TenantRole }[];
  scope: TenantScope;
};

export const CurrentAuth = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<{ auth: RequestAuth }>().auth,
);
