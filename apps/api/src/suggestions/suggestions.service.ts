import { SUGGESTION_SUBJECTS, type SuggestionSubject } from "@dishdesk/shared";
import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { DatabaseService } from "../core/database.service.js";
import { LlmClient } from "../ai/llm.client.js";

const Classification = z.object({ subject: z.enum(Object.keys(SUGGESTION_SUBJECTS) as [SuggestionSubject, ...SuggestionSubject[]]) });

const SYSTEM_PROMPT = `Você classifica sugestões que restaurantes mandam para o Dish Desk, um sistema de atendimento de restaurantes (Inbox do WhatsApp, Instagram e iFood, pedidos, clientes e automações). Escolha o assunto principal da sugestão:
${Object.entries(SUGGESTION_SUBJECTS)
  .map(([key, label]) => `- ${key}: ${label}`)
  .join("\n")}
Integrações = conectar WhatsApp, Instagram, iFood, Cardápio Web ou outro sistema. Extensão e assistente = a extensão do Chrome e a IA que ajuda a configurar. Na dúvida, outro.`;

/**
 * Sugestões dos restaurantes para o Dish Desk (painel da extensão). A sugestão é salva na hora; a IA classifica o
 * assunto em seguida, fora da resposta (se ela estiver fora do ar, a sugestão fica sem assunto).
 */
@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llm: LlmClient,
  ) {}

  async create(auth: RequestAuth, tenantId: string, text: string): Promise<void> {
    if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
    const scope = { tenantIds: [tenantId], userId: auth.userId };
    const { id } = await this.db.withTenants(scope, (tx) =>
      tx.productSuggestion.create({ data: { tenantId, userId: auth.userId, text }, select: { id: true } }),
    );
    void this.classify(scope, id, text);
  }

  private async classify(scope: { tenantIds: string[]; userId: string }, id: string, text: string): Promise<void> {
    try {
      const { subject } = await this.llm.json(scope.tenantIds[0]!, "assunto_sugestao", Classification, [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ]);
      await this.db.withTenants(scope, (tx) => tx.productSuggestion.update({ where: { id }, data: { subject } }));
    } catch (error) {
      this.logger.warn(`Sugestão ${id} sem assunto: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
