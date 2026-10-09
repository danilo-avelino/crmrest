import { z } from "zod";
import { type AutomationMessages, PERSONALITY_MESSAGES, Personality, personalityOf } from "./personalities.js";

export const ORDER_LINKS_MAX = 5;

/** Link enviado quando o cliente escolhe "2 - Fazer um pedido" no menu de atendimento. */
export const OrderLink = z.object({
  label: z.string().trim().min(1, "Informe o nome do link.").max(40, "Use até 40 caracteres."),
  url: z
    .string()
    .trim()
    .max(500, "Endereço longo demais.")
    .pipe(z.url({ protocol: /^https?$/, error: "Use um endereço completo, começando com https://" })),
});
export type OrderLink = z.infer<typeof OrderLink>;

export const UpdateOrderLinksRequest = z.object({
  orderLinks: z.array(OrderLink).max(ORDER_LINKS_MAX, `No máximo ${ORDER_LINKS_MAX} links.`),
});
export type UpdateOrderLinksRequest = z.infer<typeof UpdateOrderLinksRequest>;

/** Configurações de um restaurante na página Configurações. */
export type TenantSettingsDto = {
  tenantId: string;
  tenantName: string;
  /** Só o administrador do restaurante altera. */
  canEdit: boolean;
  personality: Personality;
  orderLinks: OrderLink[];
  automationTexts: AutomationTexts;
  businessHours: BusinessHours;
  orderForecast: OrderForecastSettings;
};

/** Os links guardados em `tenant.settings` (um valor fora do formato conta como nenhum link). */
export function orderLinksOf(settings: unknown): OrderLink[] {
  return z.looseObject({ orderLinks: z.array(OrderLink).optional() }).safeParse(settings).data?.orderLinks ?? [];
}

/** O texto que o cliente recebe com os links (o mesmo da automação); `intro` é o da personalidade. */
export function orderLinksMessage(links: OrderLink[], intro: string): string {
  return `${intro}\n${links.map((link) => `• ${link.label}: ${link.url}`).join("\n")}`;
}

/** Resposta rápida (atalho "/" no composer). O atalho aceita "/atraso" ou "atraso" e é guardado sem a barra. */
export const QuickReplyRequest = z.object({
  shortcut: z
    .string()
    .trim()
    .transform((value) => value.replace(/^\//, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9_-]{1,30}$/, "Use letras sem acento, números, - ou _ (até 30), sem espaços.")),
  content: z.string().trim().min(1, "Escreva a resposta.").max(1000, "Use até 1000 caracteres."),
});
export type QuickReplyRequest = z.infer<typeof QuickReplyRequest>;

// ---------- Mensagens automáticas (E15) ----------

/** Textos que o admin pode trocar; o padrão de cada um vem da personalidade. Na saudação, {nome} vira o primeiro nome do cliente. */
export const AUTOMATION_TEXT_KEYS = ["greeting", "phoneRequest", "phoneReminder", "phoneConfirmation"] as const;
export type AutomationTexts = Pick<AutomationMessages, (typeof AUTOMATION_TEXT_KEYS)[number]>;

/** Os textos editáveis como saem da personalidade, sem nada trocado pelo admin. */
export function automationTextDefaults(personality: Personality): AutomationTexts {
  const messages = PERSONALITY_MESSAGES[personality];
  return Object.fromEntries(AUTOMATION_TEXT_KEYS.map((key) => [key, messages[key]])) as AutomationTexts;
}

const AutomationText = z.string().trim().min(1, "Escreva a mensagem.").max(1000, "Use até 1000 caracteres.");
export const UpdateAutomationTextsRequest = z.object({
  greeting: AutomationText,
  phoneRequest: AutomationText,
  phoneReminder: AutomationText,
  phoneConfirmation: AutomationText,
});
export type UpdateAutomationTextsRequest = z.infer<typeof UpdateAutomationTextsRequest>;

/** Os textos guardados em `tenant.settings`, com o da personalidade no lugar do que faltar ou estiver fora do formato. */
export function automationTextsOf(settings: unknown): AutomationTexts {
  const saved = z.looseObject({ automationTexts: z.record(z.string(), z.unknown()).optional() }).safeParse(settings).data?.automationTexts;
  const texts = automationTextDefaults(personalityOf(settings));
  for (const key of AUTOMATION_TEXT_KEYS) {
    const value = AutomationText.safeParse(saved?.[key]);
    if (value.success) texts[key] = value.data;
  }
  return texts;
}

/** Todas as mensagens das automações do restaurante: as da personalidade, com os textos que o admin trocou. */
export function automationMessagesOf(settings: unknown): AutomationMessages {
  return {
    ...PERSONALITY_MESSAGES[personalityOf(settings)],
    ...automationTextsOf(settings),
    closedMessage: businessHoursOf(settings).closedMessage,
  };
}

export const UpdatePersonalityRequest = z.object({ personality: Personality });
export type UpdatePersonalityRequest = z.infer<typeof UpdatePersonalityRequest>;

// ---------- Previsão de saída do pedido (E26) ----------

/** showQueue: a mensagem de previsão diz quantos pedidos estão na frente na cozinha (ligado por padrão). */
export const OrderForecastSettings = z.object({ showQueue: z.boolean() });
export type OrderForecastSettings = z.infer<typeof OrderForecastSettings>;

export function orderForecastOf(settings: unknown): OrderForecastSettings {
  const saved = z.looseObject({ orderForecast: OrderForecastSettings.optional() }).safeParse(settings).data?.orderForecast;
  return saved ?? { showQueue: true };
}

/** As opções do menu de atendimento: fixas, porque a automação lê a resposta pelo número. */
export const MENU_OPTIONS = "1 - Falar sobre um pedido\n2 - Fazer um pedido\n3 - Outro assunto";

/** Saudação + opções. Sem nome, "{nome}" sai junto com a vírgula: "Olá, {nome}!" vira "Olá!". */
export function menuMessage(greeting: string, name?: string): string {
  const text = name ? greeting.replaceAll("{nome}", name) : greeting.replace(/,?[ \t]*\{nome\}/g, "");
  return `${text}\n${MENU_OPTIONS}`;
}

// ---------- Horário de funcionamento (E15) ----------

export const WEEKDAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use horas no formato 18:00.");
/** Um turno por dia; fechar antes de abrir (18:00 às 02:00) passa da meia-noite. */
const DayHours = z.object({ open: Clock, close: Clock }).refine((day) => day.open !== day.close, "Abertura e fechamento iguais.");

export const BusinessHours = z.object({
  /** Desligado: a mensagem de fora do horário nunca sai. */
  enabled: z.boolean(),
  /** Índice 0 = domingo; null = fechado o dia todo. */
  days: z.array(DayHours.nullable()).length(7),
  closedMessage: z.string().trim().min(1, "Escreva a mensagem.").max(1000, "Use até 1000 caracteres."),
});
export type BusinessHours = z.infer<typeof BusinessHours>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  enabled: false,
  days: Array.from({ length: 7 }, () => ({ open: "11:00", close: "23:00" })),
  closedMessage: PERSONALITY_MESSAGES.cordial.closedMessage,
};

/** Sem horário salvo, a mensagem de fora do horário é a da personalidade. */
export function businessHoursOf(settings: unknown): BusinessHours {
  const saved = z.looseObject({ businessHours: BusinessHours.optional() }).safeParse(settings).data?.businessHours;
  return saved ?? { ...DEFAULT_BUSINESS_HOURS, closedMessage: PERSONALITY_MESSAGES[personalityOf(settings)].closedMessage };
}

const BRASILIA_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

/** O restaurante está aberto neste instante (horário de Brasília)? */
export function isOpenAt(hours: BusinessHours, at: Date): boolean {
  const parts = Object.fromEntries(BRASILIA_CLOCK.formatToParts(at).map((part) => [part.type, part.value]));
  const day = WEEKDAYS_EN.indexOf(parts.weekday ?? "");
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const today = hours.days[day];
  const yesterday = hours.days[(day + 6) % 7];
  if (today) {
    const [open, close] = [minutesOf(today.open), minutesOf(today.close)];
    if (close > open ? now >= open && now < close : now >= open) return true;
  }
  // Turno de ontem que passou da meia-noite.
  if (yesterday) {
    const [open, close] = [minutesOf(yesterday.open), minutesOf(yesterday.close)];
    if (close <= open && now < close) return true;
  }
  return false;
}

// ---------- Usuários do restaurante (E15) ----------

/** Pessoa da equipe na aba Usuários (inclui as desativadas). */
export type TeamMemberDto = {
  userId: string;
  name: string;
  email: string;
  role: "ADMIN" | "AGENT";
  isActive: boolean;
  /** O próprio usuário: não altera o próprio acesso (outro administrador altera). */
  isYou: boolean;
};

export const CreateMemberRequest = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(80, "Use até 80 caracteres."),
  email: z.email({ error: "Informe um e-mail válido." }).transform((email) => email.toLowerCase()),
  password: z.string().min(8, "Use pelo menos 8 caracteres.").max(128, "Use até 128 caracteres."),
  role: z.enum(["ADMIN", "AGENT"]),
});
export type CreateMemberRequest = z.infer<typeof CreateMemberRequest>;

export const UpdateMemberRequest = z
  .object({ role: z.enum(["ADMIN", "AGENT"]).optional(), isActive: z.boolean().optional() })
  .refine((body) => body.role !== undefined || body.isActive !== undefined, "Nada para alterar.");
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;
