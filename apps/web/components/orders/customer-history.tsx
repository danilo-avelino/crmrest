import { CHANNEL_LABEL, type CustomerHistory } from "@dishdesk/shared";
import { count } from "@/lib/format";

/** "iFood 3 · Cardápio Web 2" */
export function sourcesText(history: Pick<CustomerHistory, "bySource">): string {
  return history.bySource.map((source) => `${CHANNEL_LABEL[source.channelType]} ${count(source.orders)}`).join(" · ");
}

/** "Este cliente tem 5 pedidos (iFood 3 · Cardápio Web 2)" ou "Primeiro pedido deste cliente". */
export function historyText(history: CustomerHistory): string {
  if (history.orders <= 1) return "Primeiro pedido deste cliente";
  return `Este cliente tem ${count(history.orders)} pedidos (${sourcesText(history)})`;
}

/** Linha do histórico do cliente na comanda (aba Pedidos e painel da conversa). */
export function CustomerHistoryLine({ history }: { history: CustomerHistory }) {
  return <p className="text-[11.5px] text-ink-2">{historyText(history)}</p>;
}
