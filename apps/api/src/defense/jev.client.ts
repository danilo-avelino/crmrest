import type { DefenseAnalysisDto, DefenseCategory } from "@dishdesk/shared";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";

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

const CATEGORY_CRITERIA: Record<DefenseCategory, string> = {
  auth_abuse: "Tentativas repetidas de login com senhas ou e-mails diferentes (força bruta, credenciais vazadas).",
  sensitive_probe: "Procura por arquivos de configuração, segredos ou painéis de outros sistemas (.env, .git, actuator, wp-admin).",
  endpoint_enumeration: "Varredura de muitas rotas que não existem, para mapear a API.",
  legitimate: "Uso normal do painel de um restaurante ou de uma integração (WhatsApp, Instagram, iFood, Stripe).",
};

const Answers = z.object({
  answers: z.object({
    category: z.object({ type: z.literal("choice"), choice: z.string() }).or(z.object({ type: z.literal("refusal") })),
    attack: z.object({ type: z.literal("noul"), noul: z.number() }).or(z.object({ type: z.literal("refusal") })),
  }),
  model: z.string(),
});

/**
 * Jev (TypeSafe AI), o modelo de decisão, pela API Decisions do OpenRouter: classifica um caso suspeito e diz a chance
 * de ser ataque. Responde só valores estruturados, sem texto. Sem JEV_API_KEY, a análise fica desligada.
 */
@Injectable()
export class JevClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return !!this.env.JEV_API_KEY;
  }

  async analyze(input: JevCase): Promise<Omit<DefenseAnalysisDto, "reused">> {
    const response = await fetch(this.env.JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.JEV_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.env.JEV_MODEL,
        state: {
          regra_que_disparou: input.rule,
          requisicoes_recentes: input.requests,
          logins_recusados: input.failedLogins,
          emails_diferentes_tentados: input.distinctEmails,
          user_agent: input.userAgent,
        },
        questions: {
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
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Jev respondeu ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const { answers, model } = Answers.parse(await response.json());
    const category =
      answers.category.type === "choice" && answers.category.choice in CATEGORY_CRITERIA ? (answers.category.choice as DefenseCategory) : null;
    const attack = answers.attack.type === "noul" ? answers.attack.noul : null;
    const conclusion = attack === null ? "uncertain" : attack >= ATTACK_FROM ? "attack" : attack <= LEGIT_UP_TO ? "legitimate" : "uncertain";
    return { category, attack, conclusion, model };
  }
}
