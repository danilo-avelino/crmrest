import type { Prisma } from "@dishdesk/database";
import {
  type AdminNotifications,
  adminNotificationsOf,
  type BusinessHours,
  businessHoursOf,
  type OrderForecastSettings,
  orderForecastOf,
  orderLinksOf,
  type PauseSettings,
  pausedOf,
  PERSONALITY_MESSAGES,
  personalityOf,
  type ReviewInviteSettings,
  reviewInviteOf,
  type TenantSettingsDto,
  type UpdateOrderLinksRequest,
  type UpdatePersonalityRequest,
} from "@dishdesk/shared";
import { Injectable } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { DatabaseService } from "../core/database.service.js";
import { notificationChannelOf } from "../notifications/admin-notifications.service.js";
import { adminScope, isTenantAdmin } from "./tenant-admin.js";

/**
 * Configurações do restaurante editadas pelo painel: personalidade, links de pedido, horário de funcionamento,
 * notificações ao administrador pelo WhatsApp.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly db: DatabaseService) {}

  /** Um restaurante no modo restaurante; todos os do usuário no painel master. */
  async list(auth: RequestAuth): Promise<TenantSettingsDto[]> {
    const tenants = await this.db.withTenants(auth.scope, async (tx) => {
      const tenants = await tx.tenant.findMany({
        // A RLS também mostra os restaurantes de que o usuário é membro fora do contexto: filtra pelo contexto.
        where: { id: { in: auth.scope.tenantIds } },
        select: { id: true, name: true, settings: true },
        orderBy: { name: "asc" },
      });
      return Promise.all(tenants.map(async (tenant) => ({ ...tenant, channel: await notificationChannelOf(tx, tenant.id) })));
    });
    return tenants.map((tenant) => toDto(auth, tenant));
  }

  updateOrderLinks(auth: RequestAuth, tenantId: string, body: UpdateOrderLinksRequest): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { orderLinks: body.orderLinks });
  }

  updateBusinessHours(auth: RequestAuth, tenantId: string, body: BusinessHours): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { businessHours: body });
  }

  updateOrderForecast(auth: RequestAuth, tenantId: string, body: OrderForecastSettings): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { orderForecast: body });
  }

  updateReviewInvite(auth: RequestAuth, tenantId: string, body: ReviewInviteSettings): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { reviewInvite: body });
  }

  updateAdminNotifications(auth: RequestAuth, tenantId: string, body: AdminNotifications): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { adminNotifications: body });
  }

  /** Pausa (ou retoma) as automações e a IA do restaurante; as mensagens continuam chegando. */
  updatePause(auth: RequestAuth, tenantId: string, body: PauseSettings): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { paused: body.paused });
  }

  /**
   * Troca o tom da IA e das mensagens automáticas. A mensagem de fora do horário que o admin não personalizou (igual à
   * da personalidade anterior) passa a ser a da nova; a personalizada fica como está.
   */
  updatePersonality(auth: RequestAuth, tenantId: string, { personality }: UpdatePersonalityRequest): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, (current) => {
      const previous = PERSONALITY_MESSAGES[personalityOf(current)].closedMessage;
      const hours = businessHoursOf(current);
      return {
        personality,
        businessHours: { ...hours, closedMessage: hours.closedMessage === previous ? PERSONALITY_MESSAGES[personality].closedMessage : hours.closedMessage },
      };
    });
  }

  /** Só o administrador do restaurante altera; as demais configurações ficam como estão. */
  private async merge(
    auth: RequestAuth,
    tenantId: string,
    patch: Prisma.InputJsonObject | ((current: Prisma.JsonObject) => Prisma.InputJsonObject),
  ): Promise<TenantSettingsDto> {
    const tenant = await this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      const { settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: { ...current, ...(typeof patch === "function" ? patch(current) : patch) } as Prisma.InputJsonObject },
        select: { id: true, name: true, settings: true },
      });
      return { ...tenant, channel: await notificationChannelOf(tx, tenantId) };
    });
    return toDto(auth, tenant);
  }
}

function toDto(
  auth: RequestAuth,
  tenant: { id: string; name: string; settings: Prisma.JsonValue; channel: { name: string } | null },
): TenantSettingsDto {
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    canEdit: isTenantAdmin(auth, tenant.id),
    personality: personalityOf(tenant.settings),
    orderLinks: orderLinksOf(tenant.settings),
    businessHours: businessHoursOf(tenant.settings),
    orderForecast: orderForecastOf(tenant.settings),
    reviewInvite: reviewInviteOf(tenant.settings),
    adminNotifications: adminNotificationsOf(tenant.settings),
    paused: pausedOf(tenant.settings),
    notificationChannel: tenant.channel?.name ?? null,
  };
}
