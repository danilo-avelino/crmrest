import {
  AddIntegrationRequest,
  type AddIntegrationResponse,
  type IfoodLinkCodeDto,
  IfoodStoresRequest,
  type IfoodStoresResultDto,
  type IntegrationDto,
  type IntegrationsDto,
  WhatsAppSignupRequest,
} from "@dishdesk/shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Redirect } from "@nestjs/common";
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
  ): Promise<AddIntegrationResponse> {
    return this.integrations.add(auth, tenantId, body);
  }

  /** iFood distribuído: conecta as lojas escolhidas entre as que vieram na autorização. */
  @Post(":tenantId/ifood/stores")
  addIfoodStores(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(IfoodStoresRequest)) body: IfoodStoresRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<IfoodStoresResultDto> {
    return this.integrations.addIfoodStores(auth, tenantId, body);
  }

  /** iFood distribuído: código de vinculação para o responsável pela loja autorizar o Dish Desk. */
  @Post(":tenantId/ifood/link-code")
  ifoodLinkCode(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<IfoodLinkCodeDto> {
    return this.integrations.ifoodLinkCode(auth, tenantId);
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

  @Delete(":tenantId/:channelId")
  @HttpCode(204)
  remove(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    return this.integrations.remove(auth, tenantId, channelId);
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
