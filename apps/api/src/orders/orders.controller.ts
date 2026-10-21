import {
  AnswerDisputeRequest,
  CancelOrderRequest,
  type CurrentOrderDto,
  type OrderAction,
  type OrderCancellationReason,
  type OrderCustomerChat,
  OrderListQuery,
  type OrderPage,
} from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { OrdersService } from "./orders.service.js";

const ForecastQuery = z.object({ conversationId: z.uuid().optional() });

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query(new ZodPipe(OrderListQuery)) query: OrderListQuery, @CurrentAuth() auth: RequestAuth): Promise<OrderPage> {
    return this.orders.list(auth, query);
  }

  /** Antes de ":id": pedido ligado ao cliente da conversa (painel lateral da Inbox). */
  @Get("current")
  async current(
    @Query("conversationId", ParseUUIDPipe) conversationId: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<{ current: CurrentOrderDto | null }> {
    return { current: await this.orders.currentForConversation(auth, conversationId) };
  }

  /** Com a conversa, vale também o pedido de outro restaurante atendido pelo canal dela. */
  @Get(":id/forecast")
  forecast(
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodPipe(ForecastQuery)) query: { conversationId?: string },
    @CurrentAuth() auth: RequestAuth,
  ): Promise<{ text: string | null }> {
    return this.orders.forecast(auth, id, query.conversationId);
  }

  @Post(":id/advance")
  @HttpCode(200)
  advance(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<{ action: OrderAction }> {
    return this.orders.advance(auth, id);
  }

  @Get(":id/cancellation-reasons")
  cancellationReasons(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<{ reasons: OrderCancellationReason[] }> {
    return this.orders.cancellationReasons(auth, id);
  }

  @Post(":id/cancel")
  @HttpCode(204)
  cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CancelOrderRequest)) body: CancelOrderRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    return this.orders.cancel(auth, id, body.code);
  }

  @Post(":id/dispute")
  @HttpCode(204)
  answerDispute(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AnswerDisputeRequest)) body: AnswerDisputeRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    return this.orders.answerDispute(auth, id, body);
  }

  @Get(":id/customer-chat")
  customerChat(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<OrderCustomerChat> {
    return this.orders.customerChat(auth, id);
  }

  @Post(":id/customer-chat")
  @HttpCode(200)
  openCustomerChat(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<{ conversationId: string }> {
    return this.orders.openCustomerChat(auth, id);
  }
}
