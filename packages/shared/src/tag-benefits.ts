import { z } from "zod";
import { AUTO_TAG_INFO, RECOVERY_TAG } from "./contacts.js";

// Vantagens por tag do cliente no cardápio próprio (22/11/2026). O cliente que entrou com o código vê os cupons das
// tags positivas e escolhe um por pedido (vale só o melhor, não acumula). As tags negativas nunca aparecem para ele:
// a recuperação entra sozinha no checkout como "Presente da casa" e a equipe pode mandar a mensagem no WhatsApp.

/** Tags que dão cupom ao cliente (o cliente vê o nome amigável, nunca a regra). */
export const BENEFIT_TAGS = ["VIP", "Recorrente", "Em risco", "Novo", "Sumido"] as const satisfies readonly (keyof typeof AUTO_TAG_INFO)[];
export type BenefitTag = (typeof BENEFIT_TAGS)[number];

/** Tags negativas: ficam escondidas do cliente e entram na recuperação. */
export const RECOVERY_TAGS = ["Insatisfeito", RECOVERY_TAG] as const;

/** Nome que o cliente vê no cupom. */
export const BENEFIT_TITLE: Record<BenefitTag, string> = {
  VIP: "Cliente VIP",
  Recorrente: "Cliente fiel",
  "Em risco": "Sentimos sua falta",
  Novo: "Boas-vindas",
  Sumido: "Que saudade!",
};

/** `MONTHLY_TIMES`: em X pedidos por mês (o X é o `perMonth` da vantagem, de 2 a 31). */
export const BENEFIT_FREQUENCIES = ["EVERY_ORDER", "MONTHLY", "MONTHLY_TIMES", "ONCE"] as const;
export type BenefitFrequency = (typeof BENEFIT_FREQUENCIES)[number];
export const BENEFIT_FREQUENCY_LABEL: Record<BenefitFrequency, string> = {
  EVERY_ORDER: "Em todo pedido",
  MONTHLY: "Uma vez por mês",
  MONTHLY_TIMES: "Em X pedidos por mês",
  ONCE: "Uma vez só",
};

const cents = z.number().int().min(0).max(100_000);
export const BENEFIT_PER_MONTH_MIN = 2;
export const BENEFIT_PER_MONTH_MAX = 31;
/** Pedidos por mês com a vantagem quando a frequência é `MONTHLY_TIMES` (ausente nas configurações antigas: 2). */
const perMonth = z.number().int().min(BENEFIT_PER_MONTH_MIN).max(BENEFIT_PER_MONTH_MAX).default(BENEFIT_PER_MONTH_MIN);

/** Entrega grátis da tag: pedido mínimo e frequência próprios (26/11/2026). */
export const FreeDeliveryPerk = z.object({ enabled: z.boolean(), minOrderCents: cents, frequency: z.enum(BENEFIT_FREQUENCIES), perMonth });
/** Cupom de desconto em R$ da tag: pedido mínimo e frequência próprios (26/11/2026). */
export const DiscountPerk = z.object({ enabled: z.boolean(), cents, minOrderCents: cents, frequency: z.enum(BENEFIT_FREQUENCIES), perMonth });

export const RecoveryBenefit = z.object({
  enabled: z.boolean(),
  discountCents: cents,
  freeDelivery: z.boolean(),
  minOrderCents: cents,
  /** Mostrar o botão de mensagem de recuperação no painel (só dentro da janela de 24 h do WhatsApp). */
  sendMessage: z.boolean(),
});
export type RecoveryBenefit = z.infer<typeof RecoveryBenefit>;

/**
 * Brinde da tag (26/11/2026; antes só do VIP): um item do cardápio que entra sozinho no carrinho do cliente da tag (entrou
 * com o código do WhatsApp) quando o pedido alcança o mínimo, a R$ 0. Não disputa com o cupom: soma com ele.
 */
export const VipGift = z.object({
  enabled: z.boolean(),
  itemId: z.string().min(1).max(64).nullable(),
  minOrderCents: cents,
  /** Quantos pedidos com brinde por mês (mês de Brasília); null = sem limite. */
  perMonth: z.number().int().min(1).max(31).nullable(),
});
export type VipGift = z.infer<typeof VipGift>;

export const DEFAULT_VIP_GIFT: VipGift = { enabled: false, itemId: null, minOrderCents: 0, perMonth: 1 };

/** Vantagens de uma tag: entrega grátis, cupom e brinde, cada um com o seu mínimo e a sua frequência. */
export const TagBenefit = z.object({ enabled: z.boolean(), freeDelivery: FreeDeliveryPerk, discount: DiscountPerk, gift: VipGift });
export type TagBenefit = z.infer<typeof TagBenefit>;

const off: TagBenefit = {
  enabled: false,
  freeDelivery: { enabled: false, minOrderCents: 0, frequency: "MONTHLY", perMonth: 2 },
  discount: { enabled: false, cents: 0, minOrderCents: 0, frequency: "MONTHLY", perMonth: 2 },
  gift: DEFAULT_VIP_GIFT,
};

/**
 * Formato salvo até 26/11/2026: entrega grátis e cupom com o mesmo mínimo e a mesma frequência, e o brinde só do VIP
 * (`vipGift`). Converte para o formato atual; o resto passa como está.
 */
function upgradeLegacy(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const old = raw as { tags?: Record<string, unknown>; vipGift?: unknown };
  if (!old.tags || typeof old.tags !== "object") return raw;
  const tags: Record<string, unknown> = {};
  for (const [tag, value] of Object.entries(old.tags)) {
    const t = value as { enabled?: unknown; freeDelivery?: unknown; discountCents?: number; minOrderCents?: number; frequency?: unknown };
    if (typeof t?.freeDelivery !== "boolean") {
      tags[tag] = value;
      continue;
    }
    tags[tag] = {
      enabled: t.enabled,
      freeDelivery: { enabled: t.freeDelivery, minOrderCents: t.minOrderCents, frequency: t.frequency },
      discount: { enabled: (t.discountCents ?? 0) > 0, cents: t.discountCents, minOrderCents: t.minOrderCents, frequency: t.frequency },
      gift: tag === "VIP" && old.vipGift ? old.vipGift : DEFAULT_VIP_GIFT,
    };
  }
  const { vipGift: _legacyGift, ...rest } = old;
  return { ...rest, tags };
}

export const TagBenefitsSettings = z.preprocess(
  upgradeLegacy,
  z.object({
    tags: z.object({
      ...(Object.fromEntries(BENEFIT_TAGS.map((tag) => [tag, TagBenefit])) as Record<BenefitTag, typeof TagBenefit>),
      // Ausente nas configurações salvas antes de 26/11/2026.
      "Em risco": TagBenefit.default(off),
    }),
    recovery: RecoveryBenefit,
  }),
);
export type TagBenefitsSettings = z.infer<typeof TagBenefitsSettings>;

export const DEFAULT_TAG_BENEFITS: TagBenefitsSettings = {
  tags: {
    VIP: { ...off, freeDelivery: { ...off.freeDelivery, enabled: true }, discount: { ...off.discount, enabled: true, cents: 1000 } },
    Recorrente: off,
    "Em risco": off,
    Novo: off,
    Sumido: off,
  },
  recovery: { enabled: false, discountCents: 1500, freeDelivery: false, minOrderCents: 0, sendMessage: true },
};

/** Configuração salva em `settings.tagBenefits`; inválida ou ausente volta ao padrão (tudo desligado, exemplo do VIP). */
export function tagBenefitsOf(settings: unknown): TagBenefitsSettings {
  const raw = (settings as { tagBenefits?: unknown } | null)?.tagBenefits;
  const parsed = TagBenefitsSettings.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_TAG_BENEFITS;
}

/** Uma parte do cupom da tag (entrega grátis ou desconto), com o mínimo e a frequência dela. */
export type CouponPartDto = {
  kind: "freeDelivery" | "discount";
  /** Desconto em centavos (0 na entrega grátis). */
  cents: number;
  minOrderCents: number;
  frequency: BenefitFrequency;
  /** Usos permitidos no período (1 em "uma vez por mês" e "uma vez só"; null em todo pedido) e quantos o cliente já fez. */
  allowed: number | null;
  used: number;
  available: boolean;
  reason: string | null;
};

/**
 * Cupom como o cliente vê (sem a regra da tag). `freeDelivery` e `discountCents` são as partes que valem agora (já
 * usadas ou abaixo do mínimo ficam de fora); `parts` traz cada uma. `available: false` (nenhuma parte vale) traz o motivo.
 */
export type CustomerCouponDto = {
  id: BenefitTag;
  title: string;
  freeDelivery: boolean;
  discountCents: number;
  parts: CouponPartDto[];
  available: boolean;
  reason: string | null;
};

/**
 * Brinde da tag como o cliente vê. `available: false` quando já usou o limite do mês (traz o motivo); o pedido mínimo
 * a tela confere com o subtotal da sacola.
 */
export type VipGiftDto = {
  /** De qual tag é o brinde: a tela escreve "Brinde VIP" só para o VIP (o cliente nunca vê o nome das outras tags). */
  tag: BenefitTag;
  name: string;
  minOrderCents: number;
  /** Brindes por mês (null = sem limite) e quantos o cliente já ganhou neste mês. */
  perMonth: number | null;
  usedThisMonth: number;
  available: boolean;
  reason: string | null;
};

/** Quanto a vantagem economiza num pedido: desconto (até o subtotal) mais a taxa, se for frete grátis. */
export function benefitSavings(benefit: { freeDelivery: boolean; discountCents: number }, subtotalCents: number, deliveryFeeCents: number): number {
  return Math.min(benefit.discountCents, subtotalCents) + (benefit.freeDelivery ? deliveryFeeCents : 0);
}
