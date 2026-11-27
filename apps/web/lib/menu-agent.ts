import { MENU_AGENT_NAME_MAX, type MenuAgentSettings, SALES_RULE_OFFERS_MAX, SALES_RULES_MAX, type SalesRule } from "@dishdesk/shared";
import { ApiError } from "@/lib/api";
import type { MenuTree } from "@/lib/menu";

// Tela Configurações → Pedidos pela IA (C4): conversão do formulário e da conversa de teste. Sem React, para testar sozinho.

export type AgentSettingsResponse = {
  settings: MenuAgentSettings;
  personality: { id: string; label: string };
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
  salesRules: SalesRule[];
  usePairings: boolean;
};

export function settingsToForm(settings: MenuAgentSettings): AgentForm {
  return {
    enabled: settings.enabled,
    attendantName: settings.attendantName ?? "",
    houseRules: settings.houseRules,
    suggestAddons: settings.suggestAddons,
    maxSuggestions: String(settings.maxSuggestionsPerConversation),
    salesRules: settings.salesRules,
    usePairings: settings.usePairings,
  };
}

export function formToPayload(form: AgentForm, rulesMax: number): { ok: true; body: MenuAgentSettings } | { ok: false; error: string } {
  const name = form.attendantName.trim();
  if (name.length > MENU_AGENT_NAME_MAX) return { ok: false, error: `O nome do atendente tem no máximo ${MENU_AGENT_NAME_MAX} caracteres.` };
  const rules = form.houseRules.trim();
  if (rules.length > rulesMax) return { ok: false, error: `As regras da casa têm no máximo ${rulesMax.toLocaleString("pt-BR")} caracteres.` };
  const salesError = salesRulesError(form.salesRules);
  if (salesError) return { ok: false, error: salesError };
  const body: MenuAgentSettings = {
    enabled: form.enabled,
    houseRules: rules,
    suggestAddons: form.suggestAddons,
    maxSuggestionsPerConversation: Number(form.maxSuggestions),
    salesRules: form.salesRules.map((rule) => ({ ...rule, pitch: rule.pitch.trim() })),
    usePairings: form.usePairings,
  };
  if (name) body.attendantName = name;
  return { ok: true, body };
}

/** "142 de 1.000" (o contador das regras da casa). */
export function rulesCounter(text: string, max: number): string {
  return `${text.length.toLocaleString("pt-BR")} de ${max.toLocaleString("pt-BR")}`;
}

/** Mudou algo em relação ao que está salvo? */
export function formChanged(form: AgentForm, saved: MenuAgentSettings): boolean {
  const base = settingsToForm(saved);
  return (Object.keys(base) as (keyof AgentForm)[]).some((key) => JSON.stringify(form[key]) !== JSON.stringify(base[key]));
}

// ---------- Venda pela IA (E48) ----------

export type SalesOfferRef = { kind: "item" | "group"; id: string };

/** As ofertas de uma regra como uma lista só (itens e complementos), na ordem de exibição. */
export const offersOf = (rule: SalesRule): SalesOfferRef[] => [...rule.groupIds.map((id) => ({ kind: "group" as const, id })), ...rule.itemIds.map((id) => ({ kind: "item" as const, id }))];

/** Grupos de complementos ligados a algum item da categoria (o que a regra "ao pedir" pode oferecer, como o combo). */
export function groupsOfCategory(menu: MenuTree, categoryId: string) {
  const linked = new Set(menu.categories.find((c) => c.id === categoryId)?.items.flatMap((item) => item.optionGroups.map((g) => g.groupId)) ?? []);
  return menu.optionGroups.filter((group) => linked.has(group.id));
}

const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const categoryLike = (menu: MenuTree, pattern: RegExp) => menu.categories.find((c) => pattern.test(plain(c.name)));

export type SalesPreset = "drink" | "dessert" | "combo" | "blank";

/**
 * Regra nova pelos atalhos: bebida e sobremesa no fim (pela categoria com esse nome) e combo ao pedir um hambúrguer (com
 * o grupo de complementos que tem "combo" no nome). Sem categoria parecida, a primeira do cardápio.
 */
export function newSalesRule(menu: MenuTree, preset: SalesPreset, id: string): SalesRule {
  const first = menu.categories[0]?.id ?? "";
  const rule = (trigger: SalesRule["trigger"], categoryId: string, groupIds: string[] = []): SalesRule => ({ id, trigger, categoryId, itemIds: [], groupIds, pitch: "" });
  if (preset === "drink") return rule("AT_END", categoryLike(menu, /bebida|drink|refri/)?.id ?? first);
  if (preset === "dessert") return rule("AT_END", categoryLike(menu, /sobremesa|doce/)?.id ?? first);
  if (preset === "combo") {
    const category = categoryLike(menu, /hamb|burger|lanche/)?.id ?? first;
    const combo = groupsOfCategory(menu, category).find((group) => /combo/.test(plain(group.name)));
    return rule("ON_ADD", category, combo ? [combo.id] : []);
  }
  return rule("ON_ADD", first);
}

/** O erro que impede salvar as regras (null: tudo certo). */
export function salesRulesError(rules: SalesRule[]): string | null {
  if (rules.length > SALES_RULES_MAX) return `São no máximo ${SALES_RULES_MAX} regras de venda.`;
  const index = rules.findIndex((rule) => !rule.categoryId);
  if (index >= 0) return `Regra ${index + 1}: escolha a categoria.`;
  const empty = rules.findIndex((rule) => rule.trigger === "ON_ADD" && rule.itemIds.length + rule.groupIds.length === 0);
  if (empty >= 0) return `Regra ${empty + 1}: escolha o que a IA oferece ao pedir um item da categoria.`;
  const many = rules.findIndex((rule) => rule.itemIds.length > SALES_RULE_OFFERS_MAX || rule.groupIds.length > SALES_RULE_OFFERS_MAX);
  return many >= 0 ? `Regra ${many + 1}: no máximo ${SALES_RULE_OFFERS_MAX} itens e ${SALES_RULE_OFFERS_MAX} complementos.` : null;
}

// ---------- Simular conversa ----------

export type SimulationCart = {
  status: "DRAFT" | "AWAITING_CONFIRMATION";
  deliveryAddress: Record<string, unknown> | null;
  items: unknown[];
};

export type SimulationResponse = {
  /** As ofertas de venda já feitas na simulação: voltam no próximo turno. */
  salesOffers: string[];
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
export function simulationBody(lines: SimulationLine[], cart: SimulationCart | null, salesOffers: string[] = []) {
  return {
    messages: lines.filter((line) => line.kind !== "note").map((line) => ({ role: line.kind as "user" | "assistant", text: line.text })),
    ...(cart && { cart }),
    ...(salesOffers.length && { salesOffers }),
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
