import { AddIntegrationRequest, type IntegrationDto, type IntegrationsDto, WhatsAppSignupRequest } from "@dishdesk/shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Redirect } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, Public, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { type InstagramCallback, IntegrationsService } from "./integrations.service.js";

const IntegrationsQuery = z.object({ tenantId: z.uuid() });
const InstagramCallbackQuery = z.looseObject({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() });

@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@Query(new ZodPipe(IntegrationsQuery)) query: { tenantId: string }, @CurrentAuth() auth: RequestAuth): Promise<IntegrationsDto> {
    return this.integrations.list(auth, query.tenantId);
  }

  @Post(":tenantId")
  add(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(AddIntegrationRequest)) body: AddIntegrationRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<IntegrationDto> {
    return this.integrations.add(auth, tenantId, body);
  }

  /** Endereço da tela de login do Instagram, para o painel abrir. */
  @Get(":tenantId/instagram/login")
  instagramLogin(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): { url: string } {
    return this.integrations.instagramLoginUrl(auth, tenantId);
  }

  /** Volta do login do Instagram (sem sessão: quem pediu vem no `state` assinado); devolve o navegador ao painel. */
  @Public()
  @Get("instagram/callback")
  @Redirect()
  async instagramCallback(@Query(new ZodPipe(InstagramCallbackQuery)) query: InstagramCallback): Promise<{ url: string }> {
    return { url: await this.integrations.finishInstagramLogin(query) };
  }

  @Post(":tenantId/:channelId/disconnect")
  disconnect(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<IntegrationDto> {
    return this.integrations.disconnect(auth, tenantId, channelId);
  }

  @Post(":tenantId/whatsapp/signup")
  whatsappSignup(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(WhatsAppSignupRequest)) body: WhatsAppSignupRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<IntegrationDto> {
    return this.integrations.whatsappSignup(auth, tenantId, body);
  }
}
