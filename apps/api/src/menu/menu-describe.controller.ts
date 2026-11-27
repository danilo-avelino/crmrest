import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AiFieldsRequest } from "./menu-ai-fields.js";
import { DescribeRequest } from "./menu-describe.js";
import { MenuDescribeService } from "./menu-describe.service.js";

/**
 * IA no formulário do item (F2-15), sempre só sugestão, com os campos do formulário (serve para item novo, ainda não
 * salvo). `POST /menu/:tenantId/items/describe` devolve `{ suggestion }` para a descrição; `POST .../items/ai-fields`
 * devolve os campos da aba "Para a IA". Só o administrador, com o módulo MENU.
 */
@Controller("menu/:tenantId/items")
export class MenuDescribeController {
  constructor(private readonly describer: MenuDescribeService) {}

  @Post("describe")
  @HttpCode(200)
  describe(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body(new ZodPipe(DescribeRequest)) body: DescribeRequest, @CurrentAuth() auth: RequestAuth) {
    return this.describer.describe(auth, tenantId, body);
  }

  @Post("ai-fields")
  @HttpCode(200)
  aiFields(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body(new ZodPipe(AiFieldsRequest)) body: AiFieldsRequest, @CurrentAuth() auth: RequestAuth) {
    return this.describer.aiFields(auth, tenantId, body);
  }
}
