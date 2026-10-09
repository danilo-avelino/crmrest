import { type CurrentOrderDto, OrderListQuery, type OrderPage } from "@dishdesk/shared";
import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { OrdersService } from "./orders.service.js";

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

  @Get(":id/forecast")
  forecast(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<{ text: string | null }> {
    return this.orders.forecast(auth, id);
  }
}
