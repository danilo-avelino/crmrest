import { effectivePaymentMethods, type MenuStoreSettings, pixExpiresMinutesOf, type UpdateMenuStoreRequest } from "@dishdesk/shared";

/** Formas de pagamento na entrega/retirada que o painel liga e desliga (o Pix online vem com a Pagar.me, F6). */
export type PayOnDelivery = "cash" | "credit" | "debit" | "pix_on_delivery";

export const PAY_ON_DELIVERY: { id: PayOnDelivery; name: string; note: string }[] = [
  { id: "cash", name: "Dinheiro", note: "Pergunta o troco no checkout" },
  { id: "credit", name: "Cartão de crédito", note: "Maquininha na entrega" },
  { id: "debit", name: "Cartão de débito", note: "Maquininha na entrega" },
  { id: "pix_on_delivery", name: "Pix na maquininha", note: "Pago ao entregador ou no balcão, não é o Pix online" },
];

export const NO_PAYMENT_METHOD = "Aceite ao menos uma forma de pagamento na entrega.";

export type PaymentsForm = Record<PayOnDelivery, boolean>;

/** O que o cliente vê hoje: lojas que só tinham Pix (padrão antigo) aparecem com todas as formas na entrega ligadas. */
export function paymentsToForm(store: MenuStoreSettings): PaymentsForm {
  const methods = effectivePaymentMethods(store);
  return { cash: methods.includes("cash"), credit: methods.includes("credit"), debit: methods.includes("debit"), pix_on_delivery: methods.includes("pix_on_delivery") };
}

/** Pix online (F6): o restaurante liga ou desliga e escolhe o prazo; o recebedor da Pagar.me só a plataforma define. */
export type PixForm = { accept: boolean; expiresMinutes: number };

export const PIX_EXPIRY_OPTIONS = [10, 15, 30, 60] as const;

export function pixToForm(store: MenuStoreSettings): PixForm {
  return { accept: Boolean(store.pixRecipientId) && store.paymentMethods.includes("pix"), expiresMinutes: pixExpiresMinutesOf(store) };
}

export const paymentsChanged = (form: PaymentsForm, store: MenuStoreSettings, pix?: PixForm): boolean => {
  const saved = paymentsToForm(store);
  const savedPix = pixToForm(store);
  if (pix && store.pixRecipientId && (pix.accept !== savedPix.accept || pix.expiresMinutes !== savedPix.expiresMinutes)) return true;
  return PAY_ON_DELIVERY.some((method) => form[method.id] !== saved[method.id]);
};

/** O corpo do PUT da loja: o resto da loja como está; o Pix online já guardado fica (ele é da F6), só as formas na entrega mudam. */
export function paymentsToPayload(
  form: PaymentsForm,
  base: MenuStoreSettings,
  pixForm?: PixForm,
): { ok: true; body: UpdateMenuStoreRequest } | { ok: false; error: string } {
  const chosen = PAY_ON_DELIVERY.filter((method) => form[method.id]).map((method) => method.id);
  if (chosen.length === 0) return { ok: false, error: NO_PAYMENT_METHOD };
  // Com o recebedor ligado, vale a escolha da tela; sem ele, o que já estava guardado fica como está.
  const acceptPix = pixForm && base.pixRecipientId ? pixForm.accept : base.paymentMethods.includes("pix");
  const pix = acceptPix ? (["pix"] as const) : [];
  const expiry = pixForm && base.pixRecipientId ? { pixExpiresMinutes: pixForm.expiresMinutes } : {};
  return { ok: true, body: { ...base, ...expiry, paymentMethods: [...pix, ...chosen] } };
}
