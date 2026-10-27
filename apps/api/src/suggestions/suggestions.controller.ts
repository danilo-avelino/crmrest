import { CreateSuggestionRequest } from "@dishdesk/shared";
import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { SuggestionsService } from "./suggestions.service.js";

/** "Fazer uma sugestão" no painel da extensão, depois da implantação. A plataforma lê em GET /platform/suggestions. */
@Controller("suggestions")
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Post()
  @HttpCode(204)
  create(@Body(new ZodPipe(CreateSuggestionRequest)) body: CreateSuggestionRequest, @CurrentAuth() auth: RequestAuth): Promise<void> {
    return this.suggestions.create(auth, body.tenantId, body.text);
  }
}
