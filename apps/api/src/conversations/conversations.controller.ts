import {
  type ConversationCounts,
  ConversationListQuery,
  type ConversationMessages,
  type ConversationPage,
  type MessageDto,
  SendMessageRequest,
  SendTemplateRequest,
  UpdateConversationRequest,
  type WhatsAppTemplate,
} from "@comanda/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ConversationsService } from "./conversations.service.js";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @Query(new ZodPipe(ConversationListQuery)) query: ConversationListQuery,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<ConversationPage> {
    return this.conversations.list(auth, query);
  }

  @Get("counts")
  counts(
    @Query(new ZodPipe(ConversationListQuery.pick({ tenantId: true }))) query: { tenantId?: string },
    @CurrentAuth() auth: RequestAuth,
  ): Promise<ConversationCounts> {
    return this.conversations.counts(auth, query.tenantId);
  }

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth) {
    return this.conversations.get(auth, id);
  }

  @Patch(":id")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateConversationRequest)) body: UpdateConversationRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.conversations.update(auth, id, body);
  }

  @Get(":id/messages")
  messages(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<ConversationMessages> {
    return this.conversations.messages(auth, id);
  }

  @Post(":id/messages")
  sendMessage(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SendMessageRequest)) body: SendMessageRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<MessageDto> {
    return this.conversations.sendText(auth, id, body.text);
  }

  @Post(":id/messages/:messageId/retry")
  @HttpCode(200)
  retryMessage(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<MessageDto> {
    return this.conversations.retryMessage(auth, id, messageId);
  }

  @Get(":id/templates")
  templates(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<WhatsAppTemplate[]> {
    return this.conversations.templates(auth, id);
  }

  @Post(":id/templates")
  sendTemplate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SendTemplateRequest)) body: SendTemplateRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<MessageDto> {
    return this.conversations.sendTemplate(auth, id, body);
  }

  @Post(":id/notes")
  addNote(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SendMessageRequest)) body: SendMessageRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<MessageDto> {
    return this.conversations.addNote(auth, id, body.text);
  }

  @Post(":id/read")
  @HttpCode(204)
  async markRead(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<void> {
    await this.conversations.markRead(auth, id);
  }
}
