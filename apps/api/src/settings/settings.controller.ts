import {
  AdminNotifications,
  BusinessHours,
  OrderForecastSettings,
  type TenantSettingsDto,
  UpdateAutomationTextsRequest,
  UpdateOrderLinksRequest,
  UpdatePersonalityRequest,
} from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AdminNotificationsService } from "../notifications/admin-notifications.service.js";
import { SettingsService } from "./settings.service.js";
import { requireTenantAdmin } from "./tenant-admin.js";

@Controller("settings")
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly adminNotifications: AdminNotificationsService,
  ) {}

  @Get()
  list(@CurrentAuth() auth: RequestAuth): Promise<TenantSettingsDto[]> {
    return this.settings.list(auth);
  }

  @Put(":tenantId/order-links")
  updateOrderLinks(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(UpdateOrderLinksRequest)) body: UpdateOrderLinksRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TenantSettingsDto> {
    return this.settings.updateOrderLinks(auth, tenantId, body);
  }

  @Put(":tenantId/automation-texts")
  updateAutomationTexts(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(UpdateAutomationTextsRequest)) body: UpdateAutomationTextsRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TenantSettingsDto> {
    return this.settings.updateAutomationTexts(auth, tenantId, body);
  }

  @Put(":tenantId/personality")
  updatePersonality(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(UpdatePersonalityRequest)) body: UpdatePersonalityRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TenantSettingsDto> {
    return this.settings.updatePersonality(auth, tenantId, body);
  }

  @Put(":tenantId/business-hours")
  updateBusinessHours(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(BusinessHours)) body: BusinessHours,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TenantSettingsDto> {
    return this.settings.updateBusinessHours(auth, tenantId, body);
  }

  @Put(":tenantId/admin-notifications")
  updateAdminNotifications(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(AdminNotifications)) body: AdminNotifications,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TenantSettingsDto> {
    return this.settings.updateAdminNotifications(auth, tenantId, body);
  }

  /** Botão "Enviar relatório de teste": o relatório semanal agora, para os números salvos. */
  @Post(":tenantId/admin-notifications/test")
  @HttpCode(200)
  async testAdminNotifications(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<{ sent: number }> {
    requireTenantAdmin(auth, tenantId);
    return { sent: await this.adminNotifications.weekly(tenantId, new Date(), true) };
  }

  @Put(":tenantId/order-forecast")
  updateOrderForecast(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(OrderForecastSettings)) body: OrderForecastSettings,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TenantSettingsDto> {
    return this.settings.updateOrderForecast(auth, tenantId, body);
  }
}
