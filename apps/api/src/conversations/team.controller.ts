import { ConversationListQuery, type MemberDto, type QuickReplyDto } from "@comanda/shared";
import { Controller, Get, Query } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { scopeFor } from "./conversations.service.js";

/** Dados de apoio da Inbox: quem pode receber conversas e as respostas rápidas. */
@Controller()
export class TeamController {
  constructor(private readonly db: DatabaseService) {}

  @Get("members")
  async members(
    @Query(new ZodPipe(ConversationListQuery.pick({ tenantId: true }))) query: { tenantId?: string },
    @CurrentAuth() auth: RequestAuth,
  ): Promise<MemberDto[]> {
    const scope = scopeFor(auth, query.tenantId);
    const members = await this.db.withTenants(scope, (tx) =>
      tx.tenantMember.findMany({
        // A RLS também mostra os vínculos do próprio usuário em outros restaurantes: filtra pelo contexto.
        where: { tenantId: { in: scope.tenantIds }, isActive: true, user: { isActive: true } },
        select: { tenantId: true, role: true, user: { select: { id: true, name: true } } },
        orderBy: { user: { name: "asc" } },
      }),
    );
    return members.map((m) => ({ id: m.user.id, name: m.user.name, tenantId: m.tenantId, role: m.role }));
  }

  @Get("quick-replies")
  quickReplies(@CurrentAuth() auth: RequestAuth): Promise<QuickReplyDto[]> {
    return this.db.withTenants(auth.scope, (tx) =>
      tx.quickReply.findMany({
        select: { id: true, tenantId: true, shortcut: true, content: true },
        orderBy: { shortcut: "asc" },
      }),
    );
  }
}
