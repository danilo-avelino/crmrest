import {
  AgentMessageRequest,
  type AgentSessionDto,
  type AgentSupportMessageDto,
  AgentTurnRequest,
  type AgentTurnDto,
  StartAgentSessionRequest,
} from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AgentService } from "./agent.service.js";

/** Agente de implantação e suporte na extensão do Chrome (E31): a página do Dish Desk no painel lateral chama estas rotas. */
@Controller("agent")
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post("sessions")
  start(@Body(new ZodPipe(StartAgentSessionRequest)) body: StartAgentSessionRequest, @CurrentAuth() auth: RequestAuth): Promise<AgentSessionDto> {
    return this.agent.start(auth, body.tenantId, body.kind);
  }

  @Post("sessions/:id/turn")
  @HttpCode(200)
  turn(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AgentTurnRequest)) body: AgentTurnRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<AgentTurnDto> {
    return this.agent.turn(auth, id, body);
  }

  @Post("sessions/:id/handoff")
  @HttpCode(200)
  handoff(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<AgentTurnDto> {
    return this.agent.handoff(auth, id);
  }

  /** Depois da transferência: a conversa com o suporte (o painel consulta de tempos em tempos). */
  @Get("sessions/:id/messages")
  messages(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<AgentSupportMessageDto[]> {
    return this.agent.supportMessages(auth, id);
  }

  @Post("sessions/:id/messages")
  @HttpCode(200)
  send(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AgentMessageRequest)) body: AgentMessageRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<AgentSupportMessageDto[]> {
    return this.agent.sendToSupport(auth, id, body.text);
  }
}
