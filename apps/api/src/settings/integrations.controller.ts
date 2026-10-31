import {
  AddIntegrationRequest,
  type AddIntegrationResponse,
  type IfoodLinkCodeDto,
  IfoodStoresRequest,
  type IfoodStoresResultDto,
  type IntegrationDto,
  type IntegrationsDto,
  RenameIntegrationRequest,
  ServedTenantsRequest,
  type WhatsAppQrDto,
  WhatsAppSignupRequest,
} from "@dishdesk/shared";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Redirect, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CurrentAuth, Public, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ENV, type Env } from "../config/env.js";
import { type InstagramCallback, IntegrationsService } from "./integrations.service.js";

const IntegrationsQuery = z.object({ tenantId: z.uuid() });
// Tentativa de conexão do WhatsApp por QR Code: o id do restaurante e um sufixo aleatório (IntegrationsService.whatsappQrStart).
const QrSession = z.string().regex(/^[0-9a-f-]{36}-[0-9a-f]{12}$/, "Tentativa de conexão inválida.");
const InstagramCallbackQuery = z.looseObject({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() });
// Prende o login do Instagram ao navegador que o abriu: a volta só conecta a conta se trouxer este cookie.
const INSTAGRAM_LOGIN_COOKIE = "dd_instagram_login";
const INSTAGRAM_LOGIN_COOKIE_PATH = "/api/integrations/instagram/callback";

@Controller("integrations")
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

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
  instagramLogin(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query("origem") origin: string | undefined,
    @CurrentAuth() auth: RequestAuth,
    @Res({ passthrough: true }) response: Response,
  ): { url: string } {
    const { url, nonce } = this.integrations.instagramLoginUrl(auth, tenantId, origin === "assistente" ? "assistente" : undefined);
    response.cookie(INSTAGRAM_LOGIN_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.env.NODE_ENV === "production",
      path: INSTAGRAM_LOGIN_COOKIE_PATH,
      maxAge: 10 * 60_000,
    });
    return { url };
  }

  /**
   * Volta do login do Instagram (sem sessão: quem pediu vem no `state` assinado, e o cookie prova que é o mesmo
   * navegador); devolve o navegador ao painel. O cookie vale uma volta só.
   */
  @Public()
  @Get("instagram/callback")
  @Redirect()
  async instagramCallback(
    @Query(new ZodPipe(InstagramCallbackQuery)) query: InstagramCallback,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ url: string }> {
    const nonce = (request.cookies as Record<string, string> | undefined)?.[INSTAGRAM_LOGIN_COOKIE];
    response.clearCookie(INSTAGRAM_LOGIN_COOKIE, { path: INSTAGRAM_LOGIN_COOKIE_PATH });
    return { url: await this.integrations.finishInstagramLogin(query, nonce) };
  }

  @Post(":tenantId/:channelId/disconnect")
  disconnect(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<IntegrationDto> {
    return this.integrations.disconnect(auth, tenantId, channelId);
  }

  @Patch(":tenantId/:channelId")
  rename(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @Body(new ZodPipe(RenameIntegrationRequest)) body: RenameIntegrationRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<IntegrationDto> {
    return this.integrations.rename(auth, tenantId, channelId, body.name);
  }

  /** WhatsApp ou Instagram: restaurantes, além deste, cujos pedidos o atendimento da conta também procura. */
  @Patch(":tenantId/:channelId/served-tenants")
  setServedTenants(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @Body(new ZodPipe(ServedTenantsRequest)) body: ServedTenantsRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<IntegrationDto> {
    return this.integrations.setServedTenants(auth, tenantId, channelId, body.tenantIds);
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

  /** WhatsApp por QR Code: cria a tentativa de conexão e devolve o primeiro QR Code. */
  @Post(":tenantId/whatsapp/qr")
  whatsappQrStart(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<WhatsAppQrDto> {
    return this.integrations.whatsappQrStart(auth, tenantId);
  }

  /** O QR Code atual ou, se o número já foi conectado, a integração. */
  @Get(":tenantId/whatsapp/qr/:session")
  whatsappQrStatus(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("session", new ZodPipe(QrSession)) session: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<WhatsAppQrDto> {
    return this.integrations.whatsappQrStatus(auth, tenantId, session);
  }

  @Delete(":tenantId/whatsapp/qr/:session")
  @HttpCode(204)
  whatsappQrCancel(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("session", new ZodPipe(QrSession)) session: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    return this.integrations.whatsappQrCancel(auth, tenantId, session);
  }
}
