import { type IfoodChatOutboxItem, IfoodChatSendResult, IfoodChatSync } from "@dishdesk/shared";
import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { IfoodChatService } from "./ifood-chat.service.js";

/** Rotas que o painel usa para copiar o chat do widget do iFood para a Inbox (só com a trava IFOOD_CHAT_BRIDGE ligada). */
@Controller("ifood-chat")
export class IfoodChatController {
  constructor(private readonly chat: IfoodChatService) {}

  @Post("sync")
  @HttpCode(204)
  async sync(@Body(new ZodPipe(IfoodChatSync)) body: IfoodChatSync, @CurrentAuth() auth: RequestAuth): Promise<void> {
    await this.chat.sync(auth, body);
  }

  @Post("outbox/claim")
  @HttpCode(200)
  claim(@CurrentAuth() auth: RequestAuth): Promise<IfoodChatOutboxItem[]> {
    return this.chat.claim(auth);
  }

  @Post("outbox/:messageId")
  @HttpCode(204)
  async result(
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @Body(new ZodPipe(IfoodChatSendResult)) body: IfoodChatSendResult,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    await this.chat.result(auth, messageId, body);
  }
}
