import type { OrderDispute, OrderPlatformInfo } from "@dishdesk/shared";
import { z } from "zod";

// Leitura do pedido e dos eventos do iFood como chegaram (guardados em `orders.raw` e `order_events.metadata`).

const Money = z.coerce.number();

const IfoodOrderInfo = z.looseObject({
  extraInfo: z.string().nullish(),
  customer: z.looseObject({ documentNumber: z.string().nullish() }).nullish(),
  delivery: z.looseObject({ pickupCode: z.string().nullish(), observations: z.string().nullish() }).nullish(),
  payments: z
    .looseObject({
      methods: z
        .array(
          z.looseObject({
            method: z.string(),
            value: Money,
            prepaid: z.boolean().default(false),
            card: z.looseObject({ brand: z.string().nullish() }).nullish(),
            cash: z.looseObject({ changeFor: Money.nullish() }).nullish(),
          }),
        )
        .default([]),
    })
    .nullish(),
  benefits: z
    .array(z.looseObject({ value: Money, sponsorshipValues: z.array(z.looseObject({ name: z.string(), value: Money })).default([]) }))
    .nullish(),
});

/** Pagamento (com o troco a levar), cupons e quem paga cada um, código de coleta, documento da nota e observações. */
export function platformInfo(raw: unknown): OrderPlatformInfo | null {
  const order = IfoodOrderInfo.safeParse(raw).data;
  if (!order) return null;
  return {
    payments: (order.payments?.methods ?? []).map((payment) => {
      // "Troco para": com quanto o cliente vai pagar em dinheiro; só interessa se for mais que o valor a cobrar.
      const changeFor = payment.cash?.changeFor ?? 0;
      const needsChange = changeFor > payment.value;
      return {
        method: payment.method,
        brand: payment.card?.brand ?? null,
        value: payment.value.toFixed(2),
        prepaid: payment.prepaid,
        changeFor: needsChange ? changeFor.toFixed(2) : null,
        change: needsChange ? (changeFor - payment.value).toFixed(2) : null,
      };
    }),
    benefits: (order.benefits ?? []).map((benefit) => ({
      value: benefit.value.toFixed(2),
      sponsors: benefit.sponsorshipValues
        .filter((sponsor) => sponsor.value > 0)
        .map((sponsor) => ({ name: sponsor.name, value: sponsor.value.toFixed(2) })),
    })),
    pickupCode: order.delivery?.pickupCode || null,
    document: order.customer?.documentNumber || null,
    notes: [order.extraInfo, order.delivery?.observations].filter((note): note is string => Boolean(note?.trim())),
  };
}

type StoredEvent = { code: string; metadata: unknown };

/** A documentação põe os motivos de aceite ora na raiz, ora em `metadata`: lê dos dois. */
const Dispute = z.looseObject({
  id: z.string(),
  action: z.string(),
  message: z.string().nullish(),
  expiresAt: z.string().nullish(),
  timeoutAction: z.string().nullish(),
  acceptCancellationReasons: z.array(z.string()).nullish(),
  metadata: z.looseObject({ acceptCancellationReasons: z.array(z.string()).nullish() }).nullish(),
});
const Settlement = z.looseObject({ disputeId: z.string(), status: z.string().optional() });

/**
 * Plataforma de Negociação: a negociação mais recente (HANDSHAKE_DISPUTE) ainda sem desfecho (HANDSHAKE_SETTLEMENT) e
 * dentro do prazo. `events` em ordem de chegada.
 */
export function openDispute(events: StoredEvent[], now: Date): OrderDispute | null {
  const settled = new Set(
    events.filter((event) => event.code === "HANDSHAKE_SETTLEMENT").map((event) => Settlement.safeParse(event.metadata).data?.disputeId),
  );
  const dispute = events
    .filter((event) => event.code === "HANDSHAKE_DISPUTE")
    .map((event) => Dispute.safeParse(event.metadata).data)
    .filter((item) => item !== undefined && !settled.has(item.id))
    .at(-1);
  if (!dispute || (dispute.expiresAt && new Date(dispute.expiresAt) <= now)) return null;
  return {
    id: dispute.id,
    action: dispute.action,
    message: dispute.message?.trim() || null,
    expiresAt: dispute.expiresAt ?? null,
    timeoutAction: dispute.timeoutAction ?? null,
    acceptReasons: dispute.acceptCancellationReasons ?? dispute.metadata?.acceptCancellationReasons ?? [],
  };
}

const SETTLEMENT_LABEL: Record<string, string> = {
  ACCEPTED: "Aceita",
  REJECTED: "Recusada",
  EXPIRED: "Sem resposta no prazo",
  ALTERNATIVE_REPLIED: "Contraproposta aceita",
};

/** O que acompanha o evento na linha do tempo: por que cancelou, o que o cliente escreveu, como a negociação terminou. */
export function eventDetail(event: StoredEvent): string | null {
  const metadata = z.record(z.string(), z.unknown()).safeParse(event.metadata).data ?? {};
  const text = (key: string) => (typeof metadata[key] === "string" && metadata[key].trim()) || null;
  if (event.code === "CANCELLED") return text("CANCEL_REASON") ?? text("CANCEL_CODE_DESCRIPTION");
  if (event.code === "CANCELLATION_REQUESTED") return text("details");
  if (event.code === "HANDSHAKE_DISPUTE") return text("message");
  if (event.code === "HANDSHAKE_SETTLEMENT") return SETTLEMENT_LABEL[text("status") ?? ""] ?? null;
  return null;
}
