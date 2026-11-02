import {
  type AgentSessionDto,
  type AgentTicketDto,
  AgentTurnRequest,
  type AgentTurnDto,
  CreateSupportTicketRequest,
  StartAgentSessionRequest,
} from "@dishdesk/shared";
import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
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

  /** A IA não resolveu e o parceiro aceitou enviar um ticket: o suporte entra em contato pelo telefone informado. */
  @Post("sessions/:id/ticket")
  ticket(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CreateSupportTicketRequest)) body: CreateSupportTicketRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<AgentTicketDto> {
    return this.agent.openTicket(auth, id, body);
  }
}
