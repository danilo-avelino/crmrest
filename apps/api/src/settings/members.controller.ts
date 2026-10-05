import type { TenantTx } from "@comanda/database";
import { CreateMemberRequest, type TeamMemberDto, UpdateMemberRequest } from "@comanda/shared";
import { hash } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { requireTenantAdmin } from "./tenant-admin.js";

/**
 * Usuários do restaurante (Configurações → Usuários): a equipe vê quem tem acesso; o administrador cria acessos, muda
 * o papel e desativa ou reativa. Ninguém altera o próprio acesso, então o restaurante nunca fica sem administrador.
 */
@Controller("settings/:tenantId/members")
export class MembersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<TeamMemberDto[]> {
    if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) => members(tx, tenantId, auth.userId));
  }

  @Post()
  async create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(CreateMemberRequest)) body: CreateMemberRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TeamMemberDto[]> {
    requireTenantAdmin(auth, tenantId);
    const passwordHash = await hash(body.password);
    const newUserId = randomUUID();
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const existing = await tx.user.findFirst({ where: { email: body.email }, select: { id: true } });
      if (existing?.id === auth.userId) throw new ForbiddenException("Peça a outro administrador para alterar o seu acesso.");
      await tx.$queryRaw`
        SELECT app.create_or_restore_member(
          ${newUserId}::uuid,
          ${tenantId}::uuid,
          ${body.name},
          ${body.email},
          ${passwordHash},
          ${body.role}::"TenantRole"
        )`;
      return members(tx, tenantId, auth.userId);
    });
  }

  @Patch(":userId")
  async update(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(UpdateMemberRequest)) body: UpdateMemberRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TeamMemberDto[]> {
    requireTenantAdmin(auth, tenantId);
    if (userId === auth.userId) throw new ForbiddenException("Peça a outro administrador para alterar o seu acesso.");
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const { count } = await tx.tenantMember.updateMany({ where: { tenantId, userId }, data: body });
      if (count === 0) throw new NotFoundException("Esta pessoa não faz parte do restaurante.");
      return members(tx, tenantId, auth.userId);
    });
  }
}

async function members(tx: TenantTx, tenantId: string, me: string): Promise<TeamMemberDto[]> {
  const rows = await tx.tenantMember.findMany({
    where: { tenantId },
    select: { role: true, isActive: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return rows.map((row) => ({
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    isActive: row.isActive,
    isYou: row.user.id === me,
  }));
}
