import { randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import {
  CreateTenantRequest,
  type PlatformAuditDto,
  type PlatformTenantDto,
  UpdateTenantStatusRequest,
} from "@dishdesk/shared";
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Painel da plataforma (Super Admin, E16): todos os restaurantes com o uso de cada um, criação, suspensão e a
 * auditoria. O super admin é conferido no banco a cada chamada (users.is_super_admin), não no token; as políticas
 * RLS da migration super_admin repetem a conferência.
 */
@Controller("platform")
export class PlatformController {
  constructor(private readonly db: DatabaseService) {}

  @Get("tenants")
  list(@CurrentAuth() auth: RequestAuth): Promise<PlatformTenantDto[]> {
    return this.tenants(auth.userId);
  }

  @Post("tenants")
  async create(
    @Body(new ZodPipe(CreateTenantRequest)) body: CreateTenantRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<PlatformTenantDto[]> {
    const passwordHash = await hash(body.adminPassword);
    const tenantId = randomUUID();
    // Restaurante e primeiro administrador na mesma transação: nunca fica um restaurante sem admin.
    await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      try {
        await tx.tenant.create({ data: { id: tenantId, name: body.name, slug: body.slug }, select: { id: true } });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw new ConflictException("Já existe um restaurante com este endereço.");
        throw error;
      }
      await tx.$queryRaw`
        SELECT app.create_or_restore_member(
          ${randomUUID()}::uuid, ${tenantId}::uuid, ${body.adminName}, ${body.adminEmail}, ${passwordHash}, 'ADMIN'::"TenantRole"
        )`;
      await tx.$executeRaw`SELECT app.log_platform_action('tenant.create', ${tenantId}::uuid)`;
    });
    return this.tenants(auth.userId);
  }

  @Patch("tenants/:tenantId")
  async updateStatus(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(UpdateTenantStatusRequest)) body: UpdateTenantStatusRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<PlatformTenantDto[]> {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      if (!(await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
        throw new NotFoundException("Restaurante não encontrado.");
      }
      await tx.$executeRaw`SELECT app.set_tenant_status(${tenantId}::uuid, ${body.status}::"TenantStatus")`;
    });
    return this.tenants(auth.userId);
  }

  @Get("audit")
  audit(@CurrentAuth() auth: RequestAuth): Promise<PlatformAuditDto[]> {
    return this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      const rows = await tx.$queryRaw<
        { id: string; action: string; user_name: string | null; tenant_id: string | null; tenant_name: string | null; created_at: Date }[]
      >`SELECT * FROM app.platform_audit(200)`;
      return rows.map((row) => ({
        id: row.id,
        action: row.action as PlatformAuditDto["action"],
        userName: row.user_name,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  private async tenants(userId: string): Promise<PlatformTenantDto[]> {
    const tenants = await this.db.withTenants({ tenantIds: [], userId }, async (tx) => {
      await requireSuperAdmin(tx, userId);
      return tx.tenant.findMany({
        select: { id: true, name: true, slug: true, status: true, createdAt: true },
        orderBy: { name: "asc" },
      });
    });
    if (tenants.length === 0) return [];

    // A lista de restaurantes veio do banco, depois de conferir o super admin; as contagens rodam no contexto deles.
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [members, channels, conversations, messages] = await this.db.withTenants(
      { tenantIds: tenants.map((t) => t.id), userId },
      (tx) =>
        Promise.all([
          tx.tenantMember.groupBy({ by: ["tenantId"], where: { isActive: true }, _count: { _all: true } }),
          tx.channel.groupBy({ by: ["tenantId"], where: { status: "CONNECTED" }, _count: { _all: true } }),
          tx.conversation.groupBy({ by: ["tenantId"], where: { status: { in: ["OPEN", "PENDING"] } }, _count: { _all: true } }),
          tx.message.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
        ]),
    );
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((row) => [row.tenantId, row._count._all]));
    const [m, c, o, msg] = [count(members), count(channels), count(conversations), count(messages)];

    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      activeMembers: m.get(t.id) ?? 0,
      connectedChannels: c.get(t.id) ?? 0,
      openConversations: o.get(t.id) ?? 0,
      messagesLast30Days: msg.get(t.id) ?? 0,
    }));
  }
}

async function requireSuperAdmin(tx: TenantTx, userId: string): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true, isActive: true } });
  if (!user?.isSuperAdmin || !user.isActive) throw new ForbiddenException("Só a equipe da plataforma acessa este painel.");
}
