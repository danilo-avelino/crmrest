import type { TenantTx } from "@dishdesk/database";
import { startOfYesterday } from "../automations/automation.js";
import { linkedOrdersWhere } from "./customer-history.js";

type ContactKeys = { id: string; phone: string | null; phoneSource: string | null; cpfHash: string | null; email: string | null };

/**
 * Pedido mais recente de hoje ou de ontem ligado ao cadastro: do próprio cadastro (qualquer canal vinculado a ele:
 * WhatsApp, Instagram, iFood, Cardápio Web) ou de outro cadastro com o mesmo telefone, CPF ou e-mail.
 * Usado pelo menu de atendimento ("Falar sobre um pedido"), pela IA e pelo painel do cliente na Inbox.
 * `exclude`: pedidos que o cliente já disse não serem dele.
 */
export function latestOrderOf(tx: TenantTx, contact: ContactKeys, now = new Date(), exclude: string[] = []) {
  return tx.order.findFirst({
    where: { placedAt: { gte: startOfYesterday(now) }, id: { notIn: exclude }, ...linkedOrdersWhere(contact) },
    include: { items: true },
    orderBy: { placedAt: "desc" },
  });
}
