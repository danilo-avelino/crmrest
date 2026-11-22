import { MENU_AGENT_NAME_MAX, MENU_AGENT_TOKENS_MAX, MENU_AGENT_TOKENS_MIN, type MenuAgentSettings } from "@dishdesk/shared";
import { ApiError } from "@/lib/api";

// Tela Configurações → Pedidos pela IA (C4): conversão do formulário e da conversa de teste. Sem React, para testar sozinho.

export type AgentSettingsResponse = {
  settings: MenuAgentSettings;
  personality: { id: string; label: string };
  /** O teto por conversa quando o restaurante não define o seu. */
  defaultDailyTokens: number;
  rulesMax: number;
  /** Há chave do Claude neste ambiente. */
  aiConfigured: boolean;
  simulationDailyLimit: number;
};

export type AgentForm = {
  enabled: boolean;
  attendantName: string;
  houseRules: string;
  suggestAddons: boolean;
  /** "0" a "3" (o select). */
  maxSuggestions: string;
  /** Tokens por conversa por dia, em texto ("400.000"); vazio: o padrão. */
  dailyTokens: string;
};

export function settingsToForm(settings: MenuAgentSettings): AgentForm {
  return {
    enabled: settings.enabled,
    attendantName: settings.attendantName ?? "",
    houseRules: settings.houseRules,
    suggestAddons: settings.suggestAddons,
    maxSuggestions: String(settings.maxSuggestionsPerConversation),
    dailyTokens: settings.dailyTokensPerConversation ? settings.dailyTokensPerConversation.toLocaleString("pt-BR") : "",
  };
}

export function formToPayload(form: AgentForm, rulesMax: number): { ok: true; body: MenuAgentSettings } | { ok: false; error: string } {
  const name = form.attendantName.trim();
  if (name.length > MENU_AGENT_NAME_MAX) return { ok: false, error: `O nome do atendente tem no máximo ${MENU_AGENT_NAME_MAX} caracteres.` };
  const rules = form.houseRules.trim();
  if (rules.length > rulesMax) return { ok: false, error: `As regras da casa têm no máximo ${rulesMax.toLocaleString("pt-BR")} caracteres.` };
  const body: MenuAgentSettings = { enabled: form.enabled, houseRules: rules, suggestAddons: form.suggestAddons, maxSuggestionsPerConversation: Number(form.maxSuggestions) };
  if (name) body.attendantName = name;
  const tokens = form.dailyTokens.replace(/[.\s]/g, "");
  if (tokens) {
    const value = Number(tokens);
    if (!/^\d+$/.test(tokens) || value < MENU_AGENT_TOKENS_MIN || value > MENU_AGENT_TOKENS_MAX) {
      return {
        ok: false,
        error: `O limite por conversa vai de ${MENU_AGENT_TOKENS_MIN.toLocaleString("pt-BR")} a ${MENU_AGENT_TOKENS_MAX.toLocaleString("pt-BR")} tokens por dia. Deixe vazio para o padrão.`,
      };
    }
    body.dailyTokensPerConversation = value;
  }
  return { ok: true, body };
}

/** "142 de 1.000" (o contador das regras da casa). */
export function rulesCounter(text: string, max: number): string {
  return `${text.length.toLocaleString("pt-BR")} de ${max.toLocaleString("pt-BR")}`;
}

/** Mudou algo em relação ao que está salvo? */
export function formChanged(form: AgentForm, saved: MenuAgentSettings): boolean {
  const base = settingsToForm(saved);
  return (Object.keys(base) as (keyof AgentForm)[]).some((key) => form[key] !== base[key]);
}

// ---------- Simular conversa ----------

export type SimulationCart = {
  status: "DRAFT" | "AWAITING_CONFIRMATION";
  deliveryAddress: Record<string, unknown> | null;
  items: unknown[];
};

export type SimulationResponse = {
  reply: string | null;
  stopped: string | null;
  handoff: string | null;
  events: string[];
  toolCalls: { name: string; input: unknown; output: unknown; isError: boolean }[];
  cart: SimulationCart | null;
};

/** Uma linha da caixa de teste: o cliente (esquerda), o agente (direita) ou um aviso da simulação (âmbar, centralizado). */
export type SimulationLine = { kind: "user" | "assistant" | "note"; text: string };

/** O que a API recebe: só as mensagens do cliente e do agente (os avisos ficam de fora) e o carrinho da volta anterior. */
export function simulationBody(lines: SimulationLine[], cart: SimulationCart | null) {
  return {
    messages: lines.filter((line) => line.kind !== "note").map((line) => ({ role: line.kind as "user" | "assistant", text: line.text })),
    ...(cart && { cart }),
  };
}

/** As linhas que a resposta da simulação acrescenta à conversa: a resposta do agente e, abaixo, os avisos (o que a equipe veria). */
export function linesOfResponse(response: SimulationResponse): SimulationLine[] {
  const lines: SimulationLine[] = [];
  if (response.reply) lines.push({ kind: "assistant", text: response.reply });
  const tools = [...new Set(response.toolCalls.map((call) => call.name))];
  if (tools.length) lines.push({ kind: "note", text: `Simulação: a IA consultou ${tools.join(", ")}` });
  for (const event of response.events) lines.push({ kind: "note", text: `Simulação: ${event}` });
  if (response.handoff) lines.push({ kind: "note", text: `Simulação: a IA chamaria a equipe (${response.handoff})` });
  if (response.stopped) lines.push({ kind: "note", text: `Simulação: o agente parou (${response.stopped}). Na conversa real, a equipe seria chamada.` });
  return lines;
}

/** A mensagem de erro da simulação, em português. */
export function simulationError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) return "A IA não está configurada neste ambiente (falta a chave da API do Claude). A simulação não está disponível.";
    return error.message;
  }
  return "Não foi possível simular agora. Confira a conexão e tente de novo.";
}
