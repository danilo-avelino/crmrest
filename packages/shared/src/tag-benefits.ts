import { z } from "zod";
import { AUTO_TAG_INFO, RECOVERY_TAG } from "./contacts.js";

// Vantagens por tag do cliente no cardápio próprio (22/11/2026). O cliente que entrou com o código vê os cupons das
// tags positivas e escolhe um por pedido (vale só o melhor, não acumula). As tags negativas nunca aparecem para ele:
// a recuperação entra sozinha no checkout como "Presente da casa" e a equipe pode mandar a mensagem no WhatsApp.

/** Tags que dão cupom ao cliente (o cliente vê o nome amigável, nunca a regra). */
export const BENEFIT_TAGS = ["VIP", "Recorrente", "Novo", "Sumido"] as const satisfies readonly (keyof typeof AUTO_TAG_INFO)[];
export type BenefitTag = (typeof BENEFIT_TAGS)[number];

/** Tags negativas: ficam escondidas do cliente e entram na recuperação. */
export const RECOVERY_TAGS = ["Insatisfeito", RECOVERY_TAG] as const;

/** Nome que o cliente vê no cupom. */
export const BENEFIT_TITLE: Record<BenefitTag, string> = {
  VIP: "Cliente VIP",
  Recorrente: "Cliente fiel",
  Novo: "Boas-vindas",
  Sumido: "Que saudade!",
};

export const BENEFIT_FREQUENCIES = ["EVERY_ORDER", "MONTHLY", "ONCE"] as const;
export type BenefitFrequency = (typeof BENEFIT_FREQUENCIES)[number];
export const BENEFIT_FREQUENCY_LABEL: Record<BenefitFrequency, string> = {
  EVERY_ORDER: "Em todo pedido",
  MONTHLY: "Uma vez por mês",
  ONCE: "Uma vez só",
};

const cents = z.number().int().min(0).max(100_000);

export const TagBenefit = z.object({
  enabled: z.boolean(),
  freeDelivery: z.boolean(),
  discountCents: cents,
  minOrderCents: cents,
  frequency: z.enum(BENEFIT_FREQUENCIES),
});
export type TagBenefit = z.infer<typeof TagBenefit>;

export const RecoveryBenefit = z.object({
  enabled: z.boolean(),
  discountCents: cents,
  freeDelivery: z.boolean(),
  minOrderCents: cents,
  /** Mostrar o botão de mensagem de recuperação no painel (só dentro da janela de 24 h do WhatsApp). */
  sendMessage: z.boolean(),
});
export type RecoveryBenefit = z.infer<typeof RecoveryBenefit>;

export const TagBenefitsSettings = z.object({
  tags: z.object(Object.fromEntries(BENEFIT_TAGS.map((tag) => [tag, TagBenefit])) as Record<BenefitTag, typeof TagBenefit>),
  recovery: RecoveryBenefit,
});
export type TagBenefitsSettings = z.infer<typeof TagBenefitsSettings>;

const off: TagBenefit = { enabled: false, freeDelivery: false, discountCents: 0, minOrderCents: 0, frequency: "MONTHLY" };
export const DEFAULT_TAG_BENEFITS: TagBenefitsSettings = {
  tags: { VIP: { ...off, freeDelivery: true, discountCents: 1000 }, Recorrente: off, Novo: off, Sumido: off },
  recovery: { enabled: false, discountCents: 1500, freeDelivery: false, minOrderCents: 0, sendMessage: true },
};

/** Configuração salva em `settings.tagBenefits`; inválida ou ausente volta ao padrão (tudo desligado, exemplo do VIP). */
export function tagBenefitsOf(settings: unknown): TagBenefitsSettings {
  const raw = (settings as { tagBenefits?: unknown } | null)?.tagBenefits;
  const parsed = TagBenefitsSettings.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_TAG_BENEFITS;
}

/** Cupom como o cliente vê (sem a regra da tag). `available: false` traz o motivo. */
export type CustomerCouponDto = {
  id: BenefitTag;
  title: string;
  freeDelivery: boolean;
  discountCents: number;
  minOrderCents: number;
  frequency: BenefitFrequency;
  available: boolean;
  reason: string | null;
};

/** Quanto a vantagem economiza num pedido: desconto (até o subtotal) mais a taxa, se for frete grátis. */
export function benefitSavings(benefit: { freeDelivery: boolean; discountCents: number }, subtotalCents: number, deliveryFeeCents: number): number {
  return Math.min(benefit.discountCents, subtotalCents) + (benefit.freeDelivery ? deliveryFeeCents : 0);
}
