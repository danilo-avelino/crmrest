import type { DefenseAnalysisDto, DefenseCategory } from "@dishdesk/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";

const TIMEOUT_MS = 15_000;
/** Chance de ataque a partir da qual o Jev confirma o caso, e até onde ele o dá como uso legítimo. */
const ATTACK_FROM = 0.85;
const LEGIT_UP_TO = 0.3;

/** O que a defesa conta ao Jev sobre um IP. Nunca vai o IP nem os e-mails tentados. */
export type JevCase = {
  rule: string;
  requests: string[];
  failedLogins: number;
  distinctEmails: number;
  userAgent: string | null;
};

/**
 * Pergunta ao Jev. `noul`: a chance de sim (0 a 1). `choice`: uma das chaves de `criteria`. `score`: a posição na
 * escala `criteria` (do primeiro ao último nível, a partir de 0; pode vir fracionada).
 */
export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

const JevAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({ type: z.literal("choice"), choice: z.string() }),
  z.object({ type: z.literal("score"), score: z.number() }),
  z.object({ type: z.literal("refusal") }),
]);
export type JevAnswer = z.infer<typeof JevAnswer>;

/** `cost`: o que o OpenRouter cobrou, em dólares (os créditos dele). */
const Usage = z.object({ input_tokens: z.number(), output_tokens: z.number(), cost: z.number().optional() });
const Response = z.object({ answers: z.record(z.string(), JevAnswer), model: z.string(), usage: Usage.optional() });

const CATEGORY_CRITERIA: Record<DefenseCategory, string> = {
  auth_abuse: "Tentativas repetidas de login com senhas ou e-mails diferentes (força bruta, credenciais vazadas).",
  sensitive_probe: "Procura por arquivos de configuração, segredos ou painéis de outros sistemas (.env, .git, actuator, wp-admin).",
  endpoint_enumeration: "Varredura de muitas rotas que não existem, para mapear a API.",
  legitimate: "Uso normal do painel de um restaurante ou de uma integração (WhatsApp, Instagram, iFood, Stripe).",
};

/**
 * Jev (TypeSafe AI), o modelo de decisão, pela API Decisions do OpenRouter: responde perguntas sobre um conteúdo só com
 * valores estruturados, sem texto. Usado na defesa da API e na avaliação dos atendimentos. Sem JEV_API_KEY, fica desligado.
 */
@Injectable()
export class JevClient {
  private readonly logger = new Logger(JevClient.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
  ) {}

  get enabled(): boolean {
    return !!this.env.JEV_API_KEY;
  }

  /**
   * Faz as perguntas sobre `state`. Uma resposta do tipo errado conta como recusa. `tenantId`: o restaurante a quem a
   * chamada serve, para o painel de gastos (null: a plataforma). `privateData`: o conteúdo é de clientes dos
   * restaurantes, e o OpenRouter só manda a provedores que não guardam os dados para treino.
   */
  async decide<K extends string>(
    tenantId: string | null,
    state: Record<string, unknown>,
    questions: Record<K, JevQuestion>,
    options: { privateData?: boolean } = {},
  ): Promise<{ answers: Record<K, JevAnswer>; model: string }> {
    const response = await fetch(this.env.JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.JEV_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.env.JEV_MODEL,
        state,
        questions,
        ...(options.privateData && { provider: { data_collection: "deny" } }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Jev respondeu ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const { answers, model, usage } = Response.parse(await response.json());
    if (usage) await this.recordUsage(tenantId, model, usage);
    const typed = {} as Record<K, JevAnswer>;
    for (const key of Object.keys(questions) as K[]) {
      const answer = answers[key];
      typed[key] = answer?.type === questions[key].type ? answer : { type: "refusal" };
    }
    return { answers: typed, model };
  }

  /**
   * Grava o gasto da chamada: no restaurante ou, sem ele, na plataforma. Uma falha aqui não derruba a resposta, que já
   * foi paga.
   */
  private async recordUsage(tenantId: string | null, model: string, usage: z.infer<typeof Usage>): Promise<void> {
    const data = {
      provider: "JEV" as const,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costMicroUsd: Math.round((usage.cost ?? 0) * 1_000_000),
    };
    try {
      await this.db.withTenants({ tenantIds: tenantId ? [tenantId] : [] }, async (tx) => {
        if (tenantId) await tx.aiUsage.create({ data: { tenantId, ...data }, select: { id: true } });
        else await tx.platformAiUsage.createMany({ data: [data] }); // sem RETURNING: só a plataforma lê a tabela
      });
    } catch (error) {
      this.logger.warn(`Gasto com o Jev não registrado: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A defesa da API: não serve a um restaurante, e o gasto fica com a plataforma. */
  async analyze(input: JevCase): Promise<Omit<DefenseAnalysisDto, "reused">> {
    const { answers, model } = await this.decide(
      null,
      {
        regra_que_disparou: input.rule,
        requisicoes_recentes: input.requests,
        logins_recusados: input.failedLogins,
        emails_diferentes_tentados: input.distinctEmails,
        user_agent: input.userAgent,
      },
      {
        category: {
          type: "choice",
          instructions: "Que tipo de tráfego é este, recebido pela API de um sistema de atendimento para restaurantes?",
          criteria: CATEGORY_CRITERIA,
        },
        attack: {
          type: "noul",
          instructions:
            "Este tráfego é um ataque (robô ou pessoa tentando invadir, mapear ou abusar da API), e não um usuário ou integração legítima?",
        },
      },
    );
    const category =
      answers.category.type === "choice" && answers.category.choice in CATEGORY_CRITERIA ? (answers.category.choice as DefenseCategory) : null;
    const attack = answers.attack.type === "noul" ? answers.attack.noul : null;
    const conclusion = attack === null ? "uncertain" : attack >= ATTACK_FROM ? "attack" : attack <= LEGIT_UP_TO ? "legitimate" : "uncertain";
    return { category, attack, conclusion, model };
  }
}
