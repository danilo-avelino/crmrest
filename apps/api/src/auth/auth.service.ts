import { randomUUID } from "node:crypto";
import type { AuthContext, AuthSession, AuthTenant, AuthUser, SelectContextRequest, SignupRequest } from "@dishdesk/shared";
import { SelectContextRequest as SelectContextSchema, slugify, tenantBilling, tenantBlock, TRIAL_DAYS } from "@dishdesk/shared";
import { hash, verify } from "@node-rs/argon2";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  type OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { DatabaseService } from "../core/database.service.js";
import {
  formatRefreshToken,
  hashSecret,
  newRefreshSecret,
  parseRefreshToken,
  sameHash,
  TokensService,
} from "./tokens.service.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Profile = { user: AuthUser; tenants: AuthTenant[] };

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = "";

  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: TokensService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await hash("senha-de-um-usuario-que-nao-existe");
  }

  async login(email: string, password: string, userAgent?: string) {
    const [found] = await this.db.client.$queryRaw<{ id: string; password_hash: string; is_active: boolean }[]>`
      SELECT id, password_hash, is_active FROM app.find_login_user(${email})`;
    // Sem usuário, verifica um hash fictício: o tempo de resposta não revela quais e-mails existem.
    const valid = await verify(found?.password_hash ?? this.dummyHash, password);
    if (!found || !valid || !found.is_active) throw new UnauthorizedException("E-mail ou senha inválidos.");

    const refreshToken = await this.openSession(found.id, userAgent);
    const profile = await this.loadProfile(found.id);
    return { refreshToken, session: { ...profile, context: null, accessToken: null } satisfies AuthSession };
  }

  /** Cadastro pelo site: cria o restaurante em teste e já entra nele como administrador. */
  async signup(body: SignupRequest, userAgent?: string) {
    const passwordHash = await hash(body.password);
    const [tenantId, userId] = [randomUUID(), randomUUID()];
    const slug = slugify(body.restaurantName).slice(0, 50) || "restaurante";
    const [result] = await this.db.client.$queryRaw<{ created: boolean }[]>`
      SELECT app.signup_tenant(
        ${tenantId}::uuid, ${userId}::uuid, ${body.restaurantName}, ${slug}, ${body.name}, ${body.email},
        ${passwordHash}, ${body.phone}, ${body.taxId}, ${TRIAL_DAYS}::int
      ) AS created`;
    if (!result?.created) throw new ConflictException("Já existe uma conta com este e-mail. Entre no sistema.");

    const refreshToken = await this.openSession(userId, userAgent);
    return { refreshToken, session: await this.selectContext(refreshToken, { mode: "tenant", tenantId }) };
  }

  /** Usuário e restaurantes da sessão do cookie, para o que acontece antes de escolher o restaurante (pagamento). */
  async sessionProfile(refreshToken: string | undefined): Promise<Profile> {
    const { userId } = await this.requireSession(refreshToken);
    return this.loadProfile(userId);
  }

  async selectContext(refreshToken: string | undefined, request: SelectContextRequest): Promise<AuthSession> {
    const { userId, sessionId } = await this.requireSession(refreshToken);
    const profile = await this.loadProfile(userId);
    const context = await this.resolveContext(userId, profile, request, { audit: true });
    await this.db.withTenants({ tenantIds: [], userId }, (tx) =>
      tx.session.update({ where: { id: sessionId }, data: { context: request } }),
    );
    return { ...profile, context, accessToken: await this.signFor(userId, context) };
  }

  /** Renova o access token a partir do cookie de sessão; sem contexto válido, volta para a escolha. */
  async refresh(refreshToken: string | undefined): Promise<AuthSession> {
    const { userId, savedContext } = await this.requireSession(refreshToken);
    const profile = await this.loadProfile(userId);
    const saved = SelectContextSchema.safeParse(savedContext);
    if (!saved.success) return { ...profile, context: null, accessToken: null };
    try {
      const context = await this.resolveContext(userId, profile, saved.data, { audit: false });
      return { ...profile, context, accessToken: await this.signFor(userId, context) };
    } catch {
      return { ...profile, context: null, accessToken: null }; // perdeu o acesso ao restaurante salvo
    }
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    await this.db.withTenants({ tenantIds: [], userId: parsed.userId }, (tx) =>
      tx.session.updateMany({
        where: { id: parsed.sessionId, tokenHash: hashSecret(parsed.secret), revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  private async openSession(userId: string, userAgent?: string): Promise<string> {
    const secret = newRefreshSecret();
    const session = await this.db.withTenants({ tenantIds: [], userId }, (tx) =>
      tx.session.create({
        data: {
          userId,
          tokenHash: hashSecret(secret),
          userAgent: userAgent?.slice(0, 300),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
        select: { id: true },
      }),
    );
    return formatRefreshToken(userId, session.id, secret);
  }

  private async requireSession(refreshToken: string | undefined) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedException();
    const session = await this.db.withTenants({ tenantIds: [], userId: parsed.userId }, (tx) =>
      tx.session.findUnique({ where: { id: parsed.sessionId } }),
    );
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt < new Date() ||
      !sameHash(session.tokenHash, hashSecret(parsed.secret))
    ) {
      throw new UnauthorizedException();
    }
    return { userId: parsed.userId, sessionId: session.id, savedContext: session.context };
  }

  private async loadProfile(userId: string): Promise<Profile> {
    const { user, memberships } = await this.db.withTenants({ tenantIds: [], userId }, async (tx) => ({
      user: await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, isSuperAdmin: true, isActive: true },
      }),
      memberships: await tx.tenantMember.findMany({
        where: { userId, isActive: true, tenant: { status: "ACTIVE" } },
        select: {
          role: true,
          tenant: {
            select: { id: true, name: true, slug: true, trialEndsAt: true, paidUntil: true, trialRevokedAt: true, trustUntil: true, billingPlan: true },
          },
        },
        orderBy: { tenant: { name: "asc" } },
      }),
    }));
    if (!user?.isActive) throw new UnauthorizedException();

    // A lista de tenants vem de TenantMember (acima); só então as contagens rodam no contexto deles.
    const tenantIds = memberships.map((m) => m.tenant.id);
    const counts = tenantIds.length
      ? await this.db.withTenants({ tenantIds }, (tx) =>
          tx.conversation.groupBy({ by: ["tenantId"], where: { status: { in: ["OPEN", "PENDING"] } }, _count: { _all: true } }),
        )
      : [];
    const open = new Map(counts.map((c) => [c.tenantId, c._count._all]));

    return {
      user: { id: user.id, name: user.name, email: user.email, isSuperAdmin: user.isSuperAdmin },
      tenants: memberships.map(({ role, tenant }) => ({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        role,
        openConversations: open.get(tenant.id) ?? 0,
        blockedBy: tenantBlock(tenant),
        billing: tenantBilling(tenant),
      })),
    };
  }

  /**
   * Restaurante ou painel master. Super admin pode entrar num restaurante de que não é membro (acesso de suporte):
   * age como administrador e a entrada fica na auditoria da plataforma. O banco confere o super admin (RLS).
   * Restaurante bloqueado (teste encerrado ou assinatura vencida) não recebe token; o acesso de suporte continua.
   */
  private async resolveContext(
    userId: string,
    profile: Profile,
    request: SelectContextRequest,
    { audit }: { audit: boolean },
  ): Promise<AuthContext> {
    if (request.mode === "master" || !profile.user.isSuperAdmin || profile.tenants.some((t) => t.id === request.tenantId)) {
      return resolveContext(profile.tenants, request);
    }
    const tenant = await this.db.withTenants({ tenantIds: [], userId }, async (tx) => {
      const found = await tx.tenant.findFirst({ where: { id: request.tenantId, status: "ACTIVE" }, select: { id: true, name: true } });
      if (found && audit) await tx.$executeRaw`SELECT app.log_platform_action('tenant.support_access', ${found.id}::uuid)`;
      return found;
    });
    if (!tenant) throw new ForbiddenException("Sem acesso a este restaurante.");
    return { mode: "tenant", support: true, tenants: [{ id: tenant.id, name: tenant.name, role: "ADMIN" }] };
  }

  private signFor(userId: string, context: AuthContext): Promise<string> {
    return this.tokens.signAccess({
      userId,
      mode: context.mode,
      tenants: context.tenants.map((t) => ({ id: t.id, role: t.role })),
    });
  }
}

function resolveContext(tenants: AuthTenant[], request: SelectContextRequest): AuthContext {
  const toContext = (list: AuthTenant[]) => list.map((t) => ({ id: t.id, name: t.name, role: t.role }));
  const blocked = () =>
    new HttpException("O acesso a este restaurante depende do pagamento da assinatura.", HttpStatus.PAYMENT_REQUIRED);
  if (request.mode === "master") {
    if (tenants.length < 2) throw new ForbiddenException("O painel master exige acesso a mais de um restaurante.");
    const open = tenants.filter((t) => !t.blockedBy);
    if (open.length === 0) throw blocked();
    return { mode: "master", tenants: toContext(open) };
  }
  const tenant = tenants.find((t) => t.id === request.tenantId);
  if (!tenant) throw new ForbiddenException("Sem acesso a este restaurante.");
  if (tenant.blockedBy) throw blocked();
  return { mode: "tenant", tenants: toContext([tenant]) };
}
