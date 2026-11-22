import type { MenuOrderInfo, MenuOrderOrigin } from "@dishdesk/shared";

/** Selo de um pedido do cardápio próprio. `tone` é o do `StatusBadge`. */
export type MenuBadge = { key: "payment" | "scheduled" | "benefit" | "origin"; tone: "resolved" | "pending" | "info"; label: string };

const clockBrt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" });
const dayBrt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });
const dateBrt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

const CARD = { credit: "cartão de crédito", debit: "cartão de débito" } as const;

/** "R$ 100" (sem centavos quando o troco é redondo; "R$ 100,50" senão). */
function troco(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: whole ? 0 : 2 }).format(cents / 100).replace(/\u00a0/g, " ");
}

/** Como o pagamento aparece: "Pago via Pix" (só o Pix online; o "Pix na maquininha" é pago na entrega), "Pagar na entrega: dinheiro, troco p/ R$ 100", "cartão de débito na retirada". */
export function menuPaymentLabel(menu: Pick<MenuOrderInfo, "payment" | "takeout">): string | null {
  const { payment, takeout } = menu;
  if (!payment) return null;
  if (payment.method === "pix") return "Pago via Pix";
  const where = takeout ? "na retirada" : "na entrega";
  if (payment.method === "cash") {
    return `Pagar ${where}: dinheiro, ${payment.changeForCents ? `troco p/ ${troco(payment.changeForCents)}` : "sem troco"}`;
  }
  if (payment.method === "pix_on_delivery") return `Pagar ${where}: Pix na maquininha`;
  return `${CARD[payment.method]} ${where}`;
}

/** "Agendado 19:30" (horário de Brasília); em outro dia, com a data: "Agendado 24/11 19:30". */
export function menuScheduledLabel(scheduledFor: string, now: Date = new Date()): string {
  const at = new Date(scheduledFor);
  const sameDay = dayBrt.format(at) === dayBrt.format(now);
  return `Agendado ${sameDay ? "" : `${dateBrt.format(at)} `}${clockBrt.format(at)}`;
}

/** Selos do pedido do cardápio (pagamento, agendamento, vantagem e origem); vazio nos demais pedidos. */
export function menuBadges(menu: MenuOrderInfo | null | undefined, now: Date = new Date()): MenuBadge[] {
  if (!menu) return [];
  const badges: MenuBadge[] = [];
  const payment = menuPaymentLabel(menu);
  if (payment) badges.push({ key: "payment", tone: menu.payment?.method === "pix" ? "resolved" : "pending", label: payment });
  if (menu.scheduledFor) badges.push({ key: "scheduled", tone: "info", label: menuScheduledLabel(menu.scheduledFor, now) });
  if (menu.benefit) {
    const parts = [menu.benefit.discountCents > 0 ? `− R$ ${(menu.benefit.discountCents / 100).toFixed(2).replace(".", ",")}` : null, menu.benefit.freeDelivery ? "frete grátis" : null].filter(Boolean);
    badges.push({ key: "benefit", tone: "resolved", label: `${menu.benefit.label}: ${parts.join(" e ")}` });
  }
  // P8: o pedido que veio da conversa com a IA ou de um anúncio ganha o selo da origem (o do site não precisa).
  if (menu.origin && menu.origin !== "site") badges.push({ key: "origin", tone: "info", label: MENU_ORIGIN_LABEL[menu.origin] });
  return badges;
}

export const MENU_ORIGIN_LABEL: Record<MenuOrderOrigin, string> = { site: "Site", whatsapp_ai: "WhatsApp pela IA", ad: "Anúncio" };

export type MenuItemName = { size: string | null; halves: string[]; title: string };

/**
 * Nome do item como o servidor grava ("½ Calabresa + ½ Frango (Grande)") separado para a cozinha: tamanho e sabores,
 * um por linha. Item inteiro: `halves` vazio e `title` com o nome.
 */
export function parseMenuItemName(name: string): MenuItemName {
  const size = /^(.*) \(([^()]+)\)$/.exec(name);
  const base = size ? size[1]! : name;
  const halves = base.startsWith("½ ") ? base.split(" + ½ ").map((part) => part.replace(/^½ /, "")) : [];
  return { size: size ? size[2]! : null, halves, title: halves.length ? halves.map((half) => `½ ${half}`).join(" + ") : base };
}
