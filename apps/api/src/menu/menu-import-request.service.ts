import type { TenantTx } from "@dishdesk/database";
import type {
  CreateMenuImportRequest,
  MenuImportRequestDto,
  PlatformMenuImportRequestDto,
  ResolveMenuImportRequest,
} from "@dishdesk/shared";
import { BadGatewayException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { IfoodAuthService } from "../connectors/ifood-auth.service.js";
import { IfoodError } from "../connectors/ifood.client.js";
import { DatabaseService } from "../core/database.service.js";
import { requireSuperAdmin } from "../platform/platform.controller.js";
import { adminScope, memberScope } from "../settings/tenant-admin.js";
import { fetchIfoodCatalog, ifoodCatalogToRows } from "./ifood-catalog.js";
import { type ImportCommitRequest, commitImportRows, existingNames } from "./menu-import.service.js";
import { planImport } from "./menu-import.js";
import { requireModule } from "./menu.service.js";

/** Pedidos abertos por restaurante ao mesmo tempo: evita repetição enquanto a equipe não responde. */
const OPEN_LIMIT = 1;
const PLATFORM_LIMIT = 500;

type Row = {
  id: string;
  source: string;
  storeName: string;
  cnpj: string;
  status: MenuImportRequestDto["status"];
  note: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

const SELECT = { id: true, source: true, storeName: true, cnpj: true, status: true, note: true, createdAt: true, resolvedAt: true } as const;

function toDto(row: Row): MenuImportRequestDto {
  return {
    id: row.id,
    source: "IFOOD",
    storeName: row.storeName,
    cnpj: row.cnpj,
    status: row.status,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Importação do cardápio do iFood por pedido: o restaurante (administrador, módulo MENU) pede com o nome da loja e o
 * CNPJ; a equipe da plataforma lê o catálogo pela Catalog API do iFood, revisa e grava no cardápio do restaurante.
 */
@Injectable()
export class MenuImportRequestService {
  private readonly logger = new Logger(MenuImportRequestService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ifood: IfoodAuthService,
  ) {}

  // ---- Restaurante ----

  list(auth: RequestAuth, tenantId: string): Promise<MenuImportRequestDto[]> {
    return this.db.withTenants(memberScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const rows = await tx.menuImportRequest.findMany({ where: { tenantId }, select: SELECT, orderBy: { createdAt: "desc" }, take: 20 });
      return rows.map(toDto);
    });
  }

  create(auth: RequestAuth, tenantId: string, body: CreateMenuImportRequest): Promise<MenuImportRequestDto> {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const open = await tx.menuImportRequest.count({ where: { tenantId, status: "OPEN" } });
      if (open >= OPEN_LIMIT) throw new ConflictException("Já existe um pedido de importação aguardando a equipe.");
      const row = await tx.menuImportRequest.create({
        data: { tenantId, userId: auth.userId, storeName: body.storeName, cnpj: body.cnpj },
        select: SELECT,
      });
      return toDto(row);
    });
  }

  // ---- Plataforma ----

  async listAll(auth: RequestAuth): Promise<PlatformMenuImportRequestDto[]> {
    const tenants = await this.superAdminTenants(auth);
    if (!tenants.length) return [];
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return this.db.withTenants({ tenantIds: tenants.map((t) => t.id), userId: auth.userId }, async (tx) => {
      const rows = await tx.menuImportRequest.findMany({
        select: { ...SELECT, tenantId: true, user: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: PLATFORM_LIMIT,
      });
      const stores = await tx.channel.findMany({
        where: { tenantId: { in: [...new Set(rows.map((r) => r.tenantId))] }, type: "IFOOD", status: "CONNECTED", deletedAt: null },
        select: { id: true, tenantId: true, name: true, externalId: true },
      });
      return rows.map((row) => ({
        ...toDto(row),
        tenantId: row.tenantId,
        tenantName: names.get(row.tenantId) ?? "",
        userName: row.user.name,
        ifoodStores: stores.filter((s) => s.tenantId === row.tenantId).map((s) => ({ channelId: s.id, name: s.name, merchantId: s.externalId })),
      }));
    });
  }

  /** Lê o catálogo do iFood da loja conectada no restaurante e mostra o que seria criado, sem gravar. */
  async preview(auth: RequestAuth, requestId: string, channelId: string) {
    const { request, store } = await this.requestAndStore(auth, requestId, channelId);
    let categories;
    try {
      categories = await fetchIfoodCatalog(this.ifood.clientFor(store), store.externalId);
    } catch (error) {
      if (error instanceof IfoodError) {
        this.logger.warn(`catálogo do iFood recusado (${error.status}) para a loja ${store.externalId}`);
        if (error.status === 401 || error.status === 403) {
          throw new UnprocessableEntityException("O iFood não liberou o catálogo desta loja para o Dish Desk (módulo Catalog não homologado ou a loja não autorizou).");
        }
        throw new BadGatewayException(`O iFood respondeu ${error.status} ao ler o catálogo.`);
      }
      throw error;
    }
    const { rows, warnings } = ifoodCatalogToRows(categories);
    const plan = await this.db.withTenants({ tenantIds: [request.tenantId], userId: auth.userId }, async (tx) => planImport(rows, await existingNames(tx, request.tenantId)));
    return { ...plan, warnings };
  }

  /** Grava as linhas revisadas no cardápio do restaurante e conclui o pedido. */
  async commit(auth: RequestAuth, requestId: string, rows: ImportCommitRequest["rows"]) {
    await this.superAdmin(auth);
    const tenantId = await this.tenantOf(auth, requestId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      await requireModule(tx, tenantId);
      const counts = await commitImportRows(tx, tenantId, rows);
      await tx.menuImportRequest.update({
        where: { id: requestId },
        data: { status: "DONE", resolvedAt: new Date(), note: `Importados ${counts.items} itens do iFood.` },
      });
      return counts;
    });
  }

  async resolve(auth: RequestAuth, requestId: string, body: ResolveMenuImportRequest): Promise<MenuImportRequestDto> {
    await this.superAdmin(auth);
    const tenantId = await this.tenantOf(auth, requestId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const row = await tx.menuImportRequest.update({
        where: { id: requestId },
        data: { status: body.status, note: body.note, resolvedAt: new Date() },
        select: SELECT,
      });
      return toDto(row);
    });
  }

  private async superAdmin(auth: RequestAuth) {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, (tx) => requireSuperAdmin(tx, auth.userId));
  }

  private async superAdminTenants(auth: RequestAuth) {
    return this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      return tx.tenant.findMany({ select: { id: true, name: true } });
    });
  }

  /** Restaurante do pedido (a busca roda com todos os restaurantes no escopo, como os outros painéis da plataforma). */
  private async tenantOf(auth: RequestAuth, requestId: string): Promise<string> {
    const tenants = await this.superAdminTenants(auth);
    const found = await this.db.withTenants({ tenantIds: tenants.map((t) => t.id), userId: auth.userId }, (tx: TenantTx) =>
      tx.menuImportRequest.findUnique({ where: { id: requestId }, select: { tenantId: true } }),
    );
    if (!found) throw new NotFoundException("Pedido de importação não encontrado.");
    return found.tenantId;
  }

  private async requestAndStore(auth: RequestAuth, requestId: string, channelId: string) {
    const tenantId = await this.tenantOf(auth, requestId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      await requireModule(tx, tenantId);
      const store = await tx.channel.findFirst({
        where: { id: channelId, tenantId, type: "IFOOD", status: "CONNECTED", deletedAt: null },
        select: { id: true, tenantId: true, externalId: true },
      });
      if (!store) throw new NotFoundException("Esta loja do iFood não está conectada neste restaurante.");
      return { request: { tenantId }, store };
    });
  }
}
