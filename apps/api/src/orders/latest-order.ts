import type { TenantTx } from "@dishdesk/database";
import { startOfYesterday } from "../automations/automation.js";
import { linkedOrdersWhere } from "./customer-history.js";

type ContactKeys = { id: string; phone: string | null; cpfHash: string | null; email: string | null };

/**
 * Pedido mais recente de hoje ou de ontem ligado ao cadastro: do próprio cadastro (qualquer canal vinculado a ele:
 * WhatsApp, Instagram, iFood, Cardápio Web) ou de outro cadastro com o mesmo telefone, CPF ou e-mail.
 * Usado pelo menu de atendimento ("Falar sobre um pedido") e pelo painel do cliente na Inbox.
 */
export function latestOrderOf(tx: TenantTx, contact: ContactKeys, now = new Date()) {
  return tx.order.findFirst({
    where: { placedAt: { gte: startOfYesterday(now) }, ...linkedOrdersWhere(contact) },
    include: { items: true },
    orderBy: { placedAt: "desc" },
  });
}
