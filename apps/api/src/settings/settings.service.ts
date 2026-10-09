import type { Prisma } from "@dishdesk/database";
import {
  AUTOMATION_TEXT_KEYS,
  type AutomationMessages,
  automationTextsOf,
  type BusinessHours,
  businessHoursOf,
  type OrderForecastSettings,
  orderForecastOf,
  orderLinksOf,
  PERSONALITY_MESSAGES,
  personalityOf,
  type TenantSettingsDto,
  type UpdateAutomationTextsRequest,
  type UpdateOrderLinksRequest,
  type UpdatePersonalityRequest,
} from "@dishdesk/shared";
import { Injectable } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { DatabaseService } from "../core/database.service.js";
import { isTenantAdmin, requireTenantAdmin } from "./tenant-admin.js";

/**
 * Configurações do restaurante editadas pelo painel: links do menu, personalidade e mensagens automáticas, horário de
 * funcionamento.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly db: DatabaseService) {}

  /** Um restaurante no modo restaurante; todos os do usuário no painel master. */
  async list(auth: RequestAuth): Promise<TenantSettingsDto[]> {
    const tenants = await this.db.withTenants(auth.scope, (tx) =>
      tx.tenant.findMany({
        // A RLS também mostra os restaurantes de que o usuário é membro fora do contexto: filtra pelo contexto.
        where: { id: { in: auth.scope.tenantIds } },
        select: { id: true, name: true, settings: true },
        orderBy: { name: "asc" },
      }),
    );
    return tenants.map((tenant) => toDto(auth, tenant));
  }

  updateOrderLinks(auth: RequestAuth, tenantId: string, body: UpdateOrderLinksRequest): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { orderLinks: body.orderLinks });
  }

  updateAutomationTexts(auth: RequestAuth, tenantId: string, body: UpdateAutomationTextsRequest): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { automationTexts: body });
  }

  updateBusinessHours(auth: RequestAuth, tenantId: string, body: BusinessHours): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { businessHours: body });
  }

  updateOrderForecast(auth: RequestAuth, tenantId: string, body: OrderForecastSettings): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, { orderForecast: body });
  }

  /**
   * Troca o tom das mensagens automáticas. Os textos editáveis que o admin não personalizou (iguais aos da personalidade
   * anterior) passam a ser os da nova; os personalizados ficam como estão.
   */
  updatePersonality(auth: RequestAuth, tenantId: string, { personality }: UpdatePersonalityRequest): Promise<TenantSettingsDto> {
    return this.merge(auth, tenantId, (current) => {
      const previous = PERSONALITY_MESSAGES[personalityOf(current)];
      const next = PERSONALITY_MESSAGES[personality];
      const swap = (key: keyof AutomationMessages, text: string) => (text === previous[key] ? next[key] : text);
      const texts = automationTextsOf(current);
      const hours = businessHoursOf(current);
      return {
        personality,
        automationTexts: Object.fromEntries(AUTOMATION_TEXT_KEYS.map((key) => [key, swap(key, texts[key])])),
        businessHours: { ...hours, closedMessage: swap("closedMessage", hours.closedMessage) },
      };
    });
  }

  /** Só o administrador do restaurante altera; as demais configurações ficam como estão. */
  private async merge(
    auth: RequestAuth,
    tenantId: string,
    patch: Prisma.InputJsonObject | ((current: Prisma.JsonObject) => Prisma.InputJsonObject),
  ): Promise<TenantSettingsDto> {
    requireTenantAdmin(auth, tenantId);
    const tenant = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const { settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
      return tx.tenant.update({
        where: { id: tenantId },
        data: { settings: { ...current, ...(typeof patch === "function" ? patch(current) : patch) } as Prisma.InputJsonObject },
        select: { id: true, name: true, settings: true },
      });
    });
    return toDto(auth, tenant);
  }
}

function toDto(auth: RequestAuth, tenant: { id: string; name: string; settings: Prisma.JsonValue }): TenantSettingsDto {
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    canEdit: isTenantAdmin(auth, tenant.id),
    personality: personalityOf(tenant.settings),
    orderLinks: orderLinksOf(tenant.settings),
    automationTexts: automationTextsOf(tenant.settings),
    businessHours: businessHoursOf(tenant.settings),
    orderForecast: orderForecastOf(tenant.settings),
  };
}
