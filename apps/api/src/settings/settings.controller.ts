import { BusinessHours, type TenantSettingsDto, UpdateAutomationTextsRequest, UpdateOrderLinksRequest } from "@comanda/shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { SettingsService } from "./settings.service.js";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

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

  @Put(":tenantId/business-hours")
  updateBusinessHours(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(BusinessHours)) body: BusinessHours,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<TenantSettingsDto> {
    return this.settings.updateBusinessHours(auth, tenantId, body);
  }
}
