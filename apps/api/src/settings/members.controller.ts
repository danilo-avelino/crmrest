import type { TenantTx } from "@dishdesk/database";
import { CreateMemberRequest, type TeamMemberDto, UpdateMemberRequest } from "@dishdesk/shared";
import { hash } from "@node-rs/argon2";
import { randomBytes, randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { hasSupabaseAuth, sendInviteEmail, type SupabaseEnv } from "../auth/supabase-auth.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { requireTenantAdmin } from "./tenant-admin.js";

/**
 * Usuários do restaurante (Configurações → Usuários): a equipe vê quem tem acesso; o administrador cria acessos (com
 * senha temporária ou convite por e-mail), muda o papel e desativa ou reativa. Ninguém altera o próprio acesso, então o
 * restaurante nunca fica sem administrador.
 */
@Controller("settings/:tenantId/members")
export class MembersController {
  private readonly logger = new Logger(MembersController.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<TeamMemberDto[]> {
    if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) => members(tx, tenantId, auth.userId));
  }

  /**
   * Sem senha, a conta nasce com uma senha aleatória que ninguém conhece e a pessoa recebe o convite para criar a dela.
   * Quem já tem conta no Dish Desk recebe o convite e fica com o acesso pendente até abrir o link do e-mail: o cadastro
   * não confere o e-mail, então a conta pode ter sido criada por outra pessoa.
   */
  @Post()
  async create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(CreateMemberRequest)) body: CreateMemberRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TeamMemberDto[]> {
    requireTenantAdmin(auth, tenantId);
    const invite = body.password === undefined;
    const env = invite ? this.inviteEnv() : null;
    const passwordHash = await hash(body.password ?? randomBytes(32).toString("base64url"));
    const newUserId = randomUUID();
    const { list, created, pending } = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const existing = await tx.user.findFirst({ where: { email: body.email }, select: { id: true } });
      if (existing?.id === auth.userId) throw new ForbiddenException("Peça a outro administrador para alterar o seu acesso.");
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT app.create_or_restore_member(
          ${newUserId}::uuid,
          ${tenantId}::uuid,
          ${body.name},
          ${body.email},
          ${passwordHash},
          ${body.role}::"TenantRole"
        ) AS id`;
      const member = await tx.tenantMember.findFirst({ where: { tenantId, userId: row?.id }, select: { invitePending: true } });
      // Sem o e-mail, a conta que já existia não teria como aceitar: nada é criado.
      if (member?.invitePending && !hasSupabaseAuth(this.env)) {
        throw new ServiceUnavailableException("Esta pessoa já tem conta no Dish Desk e precisa aceitar pelo e-mail, mas o convite por e-mail ainda não está disponível.");
      }
      return { list: await members(tx, tenantId, auth.userId), created: row?.id === newUserId, pending: member?.invitePending ?? false };
    });
    if ((env && created) || pending) {
      await this.sendInvite(this.inviteEnv(), body.email, `${body.name} foi adicionado, mas o e-mail do convite não saiu. Use "Enviar convite" na lista em alguns minutos.`);
    }
    return list;
  }

  /** Manda (de novo) o convite: o link para a pessoa criar ou trocar a senha. */
  @Post(":userId/invite")
  @HttpCode(204)
  async invite(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    requireTenantAdmin(auth, tenantId);
    const env = this.inviteEnv();
    const member = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) =>
      tx.tenantMember.findFirst({
        where: { tenantId, userId, OR: [{ isActive: true }, { invitePending: true }] },
        select: { user: { select: { email: true } } },
      }),
    );
    if (!member) throw new NotFoundException("Esta pessoa não tem acesso ativo ao restaurante.");
    await this.sendInvite(env, member.user.email, "O e-mail do convite não saiu. Tente de novo em alguns minutos.");
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
      const pending = await tx.tenantMember.count({ where: { tenantId, userId, invitePending: true } });
      if (pending && body.isActive) {
        throw new UnprocessableEntityException('Esta pessoa ainda não aceitou o convite. Use "Enviar convite" para mandar o e-mail de novo.');
      }
      // Desativar um convite pendente o cancela: o link do e-mail não libera mais o acesso.
      if (pending && body.isActive === false) await tx.$queryRaw`SELECT app.cancel_member_invite(${tenantId}::uuid, ${userId}::uuid)`;
      const { count } = await tx.tenantMember.updateMany({ where: { tenantId, userId }, data: body });
      if (count === 0) throw new NotFoundException("Esta pessoa não faz parte do restaurante.");
      return members(tx, tenantId, auth.userId);
    });
  }

  private inviteEnv(): SupabaseEnv {
    if (!hasSupabaseAuth(this.env)) {
      throw new ServiceUnavailableException("O convite por e-mail ainda não está disponível. Defina uma senha temporária.");
    }
    return this.env;
  }

  /** `failure`: o que o administrador lê se o e-mail não sair. */
  private async sendInvite(env: SupabaseEnv, email: string, failure: string): Promise<void> {
    try {
      await sendInviteEmail(env, email);
    } catch (error) {
      this.logger.error({ err: error }, "E-mail de convite não enviado");
      throw new ServiceUnavailableException(failure);
    }
  }
}

async function members(tx: TenantTx, tenantId: string, me: string): Promise<TeamMemberDto[]> {
  const rows = await tx.tenantMember.findMany({
    where: { tenantId },
    select: { role: true, isActive: true, invitePending: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return rows.map((row) => ({
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    isActive: row.isActive,
    invitePending: row.invitePending,
    isYou: row.user.id === me,
  }));
}
