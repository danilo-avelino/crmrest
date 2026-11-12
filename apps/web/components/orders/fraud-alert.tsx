"use client";

import { CHANNEL_ARTICLE, CHANNEL_LABEL, type CanceledOrderRow, type CurrentOrderDto, type CustomerCancellations, type OrderAlertDto, type OrderDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, LockIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { CancelOrderDialog } from "@/components/orders/cancel-order-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { usePendingAction } from "@/hooks/use-pending-action";
import { clock, count, currency, dayMonth, fullDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Depois de uma decisão, tudo que mostra o pedido ou o alerta precisa de dados novos. */
export function useFraudRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["current-order", "orders", "conversations", "conversation", "messages", "contact", "contacts"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

const orderCode = (order: { displayCode: string | null; id: string }) => `#${order.displayCode ?? order.id.slice(0, 6)}`;

function plural(value: number, one: string, many: string): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

/** Onde cancelar quando o Dish Desk não pode. */
function cancelElsewhere(channelType: OrderDto["channelType"]): { where: string; why: string } {
  const label = CHANNEL_LABEL[channelType];
  if (channelType === "IFOOD") return { where: "no Gestor de Pedidos do iFood", why: "O Dish Desk só acompanha os pedidos do iFood." };
  const article = CHANNEL_ARTICLE[channelType];
  return { where: `n${article} ${label}`, why: `${article.toUpperCase()} ${label} não permite cancelar pelo Dish Desk.` };
}

/** Selo vermelho da lista da Inbox e da aba Pedidos. */
export function FraudBadge({ children = "Alerta de fraude" }: { children?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-tomate px-[7px] text-[11px] leading-[17px] font-semibold whitespace-nowrap text-white">
      <ShieldAlertIcon className="size-[11px]" aria-hidden />
      {children}
    </span>
  );
}

/** Alerta na conversa: logo abaixo do cabeçalho, empurrando as mensagens para baixo. */
export function ConversationFraudAlert({ conversationId, teamOnly }: { conversationId: string; teamOnly: boolean }) {
  const { request } = useAuth();
  // A mesma consulta do painel do pedido: as duas telas mudam juntas.
  const query = useQuery({
    queryKey: ["current-order", conversationId],
    queryFn: () => request<{ current: CurrentOrderDto | null }>(`/orders/current?conversationId=${conversationId}`),
    refetchInterval: 30_000,
  });
  const current = query.data?.current;
  return (
    <>
      {teamOnly && (
        <div className="shrink-0 px-4 pt-3">
          <div className="flex items-start gap-2 rounded-md border border-dashed border-tag-line bg-warning-lt px-3 py-2.5 text-[12.5px] text-warning-ink">
            <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <strong className="font-semibold">O cliente não está nesta conversa.</strong> O pedido chegou sem chat e o Dish Desk abriu esta conversa só para
              a equipe ver o alerta. Nada do que for escrito aqui chega ao cliente.
            </span>
          </div>
        </div>
      )}
      {current?.alert && (
        <div className="max-h-[60%] shrink-0 overflow-y-auto px-4 pt-3">
          <FraudAlert key={current.order.id} order={current.order} alert={current.alert} cancelable={current.cancelable} teamOnly={teamOnly} />
        </div>
      )}
    </>
  );
}

const VERDICT_LABEL = { high: "alto", uncertain: "incerto", low: "baixo" } as const;

/**
 * Alerta de fraude de um pedido: em aberto, recolhido ou, depois da decisão, uma linha discreta. No nível "LOW" é só um
 * aviso: abre recolhido e em âmbar. Nada aqui vai para o cliente.
 */
export function FraudAlert({
  order,
  alert,
  cancelable,
  teamOnly = false,
}: {
  order: Pick<OrderDto, "id" | "displayCode" | "channelType" | "total" | "items">;
  alert: OrderAlertDto;
  cancelable: boolean;
  teamOnly?: boolean;
}) {
  const { request } = useAuth();
  const refresh = useFraudRefresh();
  const low = alert.level === "LOW";
  const title = low ? "Atenção ao histórico" : "Alerta de fraude";
  const [collapsed, setCollapsed] = useState(low);
  const [canceling, setCanceling] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [keep, keeping] = usePendingAction(async () => {
    setFailed(false);
    try {
      await request(`/orders/${order.id}/keep`, { method: "POST" });
      refresh();
    } catch {
      setFailed(true);
    }
  });

  const { decision, cancellations } = alert;
  const label = CHANNEL_LABEL[order.channelType];
  const dialog = <CancelOrderDialog order={order} open={canceling} onOpenChange={setCanceling} onDone={refresh} />;

  if (decision && !reviewing) {
    const who = decision.by?.split(" ")[0] ?? "a equipe";
    return (
      <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2 text-[12px] text-ink-2">
        <ShieldAlertIcon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        {decision.kind === "CANCELING" ? (
          <>
            <span>
              <strong className="font-medium text-ink">Cancelamento pedido, aguardando o {label}</strong> · por {who} às {clock(decision.at)}
            </span>
            <span className="ml-auto inline-flex items-center gap-1 rounded-sm border border-warning-line bg-warning-lt px-[7px] text-[11px] leading-[17px] font-medium text-warning-ink">
              <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
              Aguardando
            </span>
          </>
        ) : (
          <>
            <span>
              Alerta de fraude ·{" "}
              <strong className="font-medium text-ink">
                Pedido {decision.kind === "KEPT" ? "mantido" : "cancelado"} por {who} às {clock(decision.at)}
              </strong>
              {decision.fraud && " · marcado como fraude"}
            </span>
            <button type="button" onClick={() => setReviewing(true)} className="ml-auto shrink-0 text-[12px] font-medium text-tomate underline">
              Ver alerta
            </button>
          </>
        )}
      </div>
    );
  }

  const actions = alert.actionable && !decision && (
    <>
      <Button variant="outline" size={collapsed ? "xs" : "sm"} loading={keeping} disabled={keeping} onClick={keep}>
        Manter pedido
      </Button>
      {cancelable && (
        <Button variant="accent" size={collapsed ? "xs" : "sm"} disabled={keeping} onClick={() => setCanceling(true)}>
          Cancelar pedido
        </Button>
      )}
    </>
  );

  if (collapsed) {
    return (
      <div className={cn("flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-[12px] text-ink-2", low ? "border-warning-line" : "border-tomate")}>
        <ShieldAlertIcon className={cn("size-3.5 shrink-0", low ? "text-warning" : "text-tomate")} aria-hidden />
        <span className="min-w-0 truncate">
          <strong className="font-semibold text-ink">{title}</strong>
          {cancellations.canceledCount > 0 && ` · ${plural(cancellations.canceledCount, "cancelamento", "cancelamentos")}`} · {label} {orderCode(order)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
          <button type="button" onClick={() => setCollapsed(false)} className="text-[12px] font-medium text-tomate underline">
            Abrir
          </button>
        </span>
        {dialog}
      </div>
    );
  }

  const elsewhere = !cancelable && !decision ? cancelElsewhere(order.channelType) : null;
  return (
    <section
      aria-label={title}
      className={cn("overflow-hidden rounded-xl border bg-surface", low ? "border-warning-line" : "border-tomate shadow-[0_14px_30px_-18px_rgba(196,52,26,.45)]")}
    >
      <div
        className={cn(
          "flex items-center gap-2 px-3.5 py-2 text-[12.5px] font-semibold",
          low ? "border-b border-warning-line bg-warning-lt text-warning-ink" : "bg-tomate text-white",
        )}
      >
        <ShieldAlertIcon className="size-3.5" aria-hidden />
        {title}
        <span className="ml-auto flex items-center gap-3 text-[11.5px] font-normal">
          <span className="inline-flex items-center gap-1">
            <LockIcon className="size-3" aria-hidden />
            Só a equipe vê
          </span>
          {decision ? (
            <button type="button" onClick={() => setReviewing(false)} className="font-medium underline">
              Fechar
            </button>
          ) : (
            <button type="button" onClick={() => setCollapsed(true)} className="font-medium underline">
              Recolher
            </button>
          )}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <AlertSummary alert={alert} />
        {alert.analysis && (
          <p className="m-0 text-[12px] text-ink-2">
            Análise da IA: <strong className="font-semibold text-ink">risco {VERDICT_LABEL[alert.analysis.verdict]}</strong>{" "}
            <span className="tabular-nums">({Math.round(alert.analysis.risk * 100)}%)</span>. A decisão continua sendo sua.
          </p>
        )}
        <div className="flex items-center gap-2.5 rounded-md border border-rule bg-paper px-3 py-2 text-[12.5px]">
          <span className={cn("size-2 shrink-0 rounded-full", CHANNEL_DOT[order.channelType])} />
          <span className="font-semibold whitespace-nowrap">
            {label} {orderCode(order)}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-2">{order.items.map((item) => `${item.quantity}× ${item.name}`).join(" · ")}</span>
          <span className="font-semibold whitespace-nowrap tabular-nums">{currency(order.total)}</span>
        </div>
        {cancellations.rows.length > 0 && <CancellationTable cancellations={cancellations} limit={3} customerName={alert.customerName} />}
        {alert.addressMatches.length > 0 && <AddressBlock alert={alert} />}
        {elsewhere && (
          <div className="rounded-md border border-dashed border-tag-line bg-warning-lt px-3 py-2.5 text-[12.5px] text-warning-ink">
            <strong className="font-semibold">Cancele este pedido {elsewhere.where}.</strong> {elsewhere.why}
          </div>
        )}
        {failed && (
          <p role="alert" className="text-[12px] text-tomate">
            Não foi possível salvar a decisão. Confira a conexão e tente de novo.
          </p>
        )}
      </div>
      {!decision && (
        <div className="flex items-center gap-2 border-t border-rule-soft px-3.5 py-2.5">
          <span className="mr-auto text-[11.5px] text-ink-3">
            {!alert.actionable
              ? "Pedido de outra unidade: a decisão é de quem atende lá."
              : teamOnly
                ? "Sem conversa: o cancelamento não envia mensagem ao cliente."
                : "Nada é cancelado sem você confirmar."}
          </span>
          {actions}
        </div>
      )}
      {dialog}
    </section>
  );
}

function AlertSummary({ alert }: { alert: OrderAlertDto }) {
  const { canceledCount, ordersCount } = alert.cancellations;
  const name = alert.customerName ?? "Este cliente";
  const matches = alert.addressMatches.length;
  return (
    <p className="m-0 text-ink-2">
      {canceledCount > 0 ? (
        <>
          {name} tem <strong className="font-semibold text-ink tabular-nums">{plural(canceledCount, "pedido cancelado", "pedidos cancelados")}</strong> de{" "}
          {count(ordersCount)} {ordersCount === 1 ? "feito" : "feitos"}
          {matches > 0 ? (
            <>
              , e <strong className="font-semibold text-ink">o endereço tem {matches === 1 ? "um pedido marcado" : `${matches} pedidos marcados`} como fraude</strong>.
            </>
          ) : (
            ". Veja o motivo de cada um antes de decidir."
          )}
        </>
      ) : (
        <>
          {name} não tem cancelamentos, mas <strong className="font-semibold text-ink">o endereço de entrega já teve {matches === 1 ? "um pedido marcado" : `${matches} pedidos marcados`} como fraude</strong>.
        </>
      )}
    </p>
  );
}

/** Pedidos marcados no mesmo endereço, de outro cliente: sem nome, telefone nem itens dele. */
function AddressBlock({ alert }: { alert: OrderAlertDto }) {
  const matches = alert.addressMatches;
  return (
    <div className="flex flex-col gap-[3px] rounded-md border border-tomate-line bg-tomate-lt px-3 py-2.5">
      <h4 className="m-0 text-[12.5px] font-semibold text-tomate-ink">
        Este endereço tem {matches.length === 1 ? "um pedido marcado" : `${matches.length} pedidos marcados`} como fraude
      </h4>
      {alert.address && <div className="font-medium text-ink">{alert.address}</div>}
      {matches.map((match, index) => (
        <div key={index} className="text-[12px] text-ink-2">
          Pedido de {fullDate(match.placedAt)} · {match.reason ? `Motivo: ${match.reason}` : "Motivo não informado"}
          {match.markedBy && ` · Marcado por ${match.markedBy.split(" ")[0]}`}
          {match.similar && (
            <span className="block">
              Endereço escrito de outro jeito, que a IA deu como o mesmo local{match.address && `: ${match.address}`}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const COLUMNS = "grid grid-cols-[44px_132px_54px_74px_minmax(0,1fr)] items-center gap-2.5 px-3 text-[12px]";

/** Lista de cancelamentos: no alerta, os mais recentes; "Ver todos" abre a lista completa numa janela, sem sair da conversa. */
export function CancellationTable({
  cancellations,
  limit,
  customerName,
}: {
  cancellations: CustomerCancellations;
  limit?: number;
  customerName?: string | null;
}) {
  const [all, setAll] = useState(false);
  const rows = limit ? cancellations.rows.slice(0, limit) : cancellations.rows;
  const hidden = cancellations.rows.length > rows.length;
  return (
    <div className="overflow-hidden rounded-md border border-rule">
      <div className={cn(COLUMNS, "bg-surface-2 py-[5px] text-[11px] font-medium text-ink-3")}>
        <span>Data</span>
        <span>Origem</span>
        <span>Pedido</span>
        <span className="text-right">Valor</span>
        <span>Motivo</span>
      </div>
      {rows.map((row) => (
        <CancellationRow key={row.id} row={row} />
      ))}
      {hidden && (
        <div className="flex items-center justify-between border-t border-rule-soft px-3 py-1.5 text-[12px] text-ink-3">
          <span className="tabular-nums">
            Mostrando {rows.length} de {count(cancellations.canceledCount)}
          </span>
          <button type="button" onClick={() => setAll(true)} className="text-[12px] font-medium text-tomate underline">
            Ver todos os {count(cancellations.canceledCount)} cancelamentos
          </button>
        </div>
      )}
      <Dialog open={all} onOpenChange={setAll}>
        <DialogContent className="w-[720px]">
          <div className="px-5 pt-[18px]">
            <DialogTitle className="text-[16px]">Cancelamentos{customerName ? ` de ${customerName}` : ""}</DialogTitle>
            <DialogDescription className="mt-1 tabular-nums">{cancellationsLine(cancellations)}</DialogDescription>
          </div>
          <div className="max-h-[60vh] overflow-y-auto px-5 py-3.5">
            {all && <CancellationTable cancellations={cancellations} />}
          </div>
          <div className="flex justify-end border-t border-rule px-5 py-3">
            <Button variant="outline" onClick={() => setAll(false)}>
              Fechar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "4 de 9 pedidos · iFood 2 · Cardápio Web 2 · 1 marcado como fraude" */
function cancellationsLine({ canceledCount, ordersCount, bySource, fraudCount }: CustomerCancellations): string {
  return [
    `${count(canceledCount)} de ${plural(ordersCount, "pedido", "pedidos")}`,
    ...bySource.map((source) => `${CHANNEL_LABEL[source.channelType]} ${count(source.orders)}`),
    ...(fraudCount > 0 ? [plural(fraudCount, "marcado como fraude", "marcados como fraude")] : []),
  ].join(" · ");
}

function CancellationRow({ row }: { row: CanceledOrderRow }) {
  return (
    <div className={cn(COLUMNS, "border-t border-rule-soft py-[7px]")}>
      <span className="tabular-nums">{dayMonth(row.placedAt)}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-[5px] whitespace-nowrap">
          <span className={cn("size-2 shrink-0 rounded-full", CHANNEL_DOT[row.channelType])} />
          {CHANNEL_LABEL[row.channelType]}
        </span>
        {row.restaurantName && <span className="block truncate text-[10.5px] text-ink-3">{row.restaurantName}</span>}
      </span>
      <span className="tabular-nums">{row.displayCode ? `#${row.displayCode}` : "—"}</span>
      <span className="text-right tabular-nums">{currency(row.total)}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1", row.reason ? "text-ink" : "text-ink-3 italic")}>
          {row.reason ?? "Motivo não informado"}
          {row.imported && <SmallBadge tone="neutral">Importado</SmallBadge>}
          {row.afterDispatch && <SmallBadge tone="neutral">Após a saída</SmallBadge>}
          {!row.counted && <SmallBadge tone="neutral">Pela loja</SmallBadge>}
          {row.fraud && <SmallBadge tone="fraud">Fraude</SmallBadge>}
        </span>
        <FraudMarkControl row={row} />
      </span>
    </div>
  );
}

function SmallBadge({ tone, children }: { tone: "neutral" | "fraud"; children: string }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-[6px] text-[10.5px] leading-[15px] not-italic",
        tone === "fraud" ? "border-tomate bg-tomate font-semibold text-white" : "border-rule bg-surface-2 font-medium text-ink-2",
      )}
    >
      {children}
    </span>
  );
}

/** "Marcar como fraude" num pedido cancelado, ou quem marcou e "Remover marca", sempre com uma confirmação curta. */
export function FraudMarkControl({ row }: { row: CanceledOrderRow }) {
  const { request } = useAuth();
  const refresh = useFraudRefresh();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const code = row.displayCode ? `#${row.displayCode}` : "";
  const marked = row.fraud !== null;

  const confirm = async () => {
    setError(false);
    try {
      await request(`/orders/${row.id}/fraud`, { method: marked ? "DELETE" : "POST" });
      setOpen(false);
      refresh();
    } catch {
      setError(true);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
      {row.fraud && (
        <span className="tabular-nums">
          Marcado como fraude{row.fraud.by && ` por ${row.fraud.by.split(" ")[0]}`}, {dayMonth(row.fraud.at)} às {clock(row.fraud.at)}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setError(false);
          setOpen(true);
        }}
        className={cn("text-[11px] font-medium underline", marked ? "text-ink-2" : "text-tomate")}
      >
        {marked ? "Remover marca" : "Marcar como fraude"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[420px]">
          <div className="flex flex-col gap-1.5 px-5 pt-[18px] pb-3.5">
            <DialogTitle className="text-[16px]">{marked ? "Remover a marca de fraude?" : `Marcar o pedido ${code} como fraude?`}</DialogTitle>
            <DialogDescription className="text-ink-2">
              {marked
                ? `O pedido ${code} deixa de aparecer no alerta dos próximos pedidos${row.address ? ` para ${row.address}` : ""}.`
                : row.address
                  ? "Os próximos pedidos para este endereço vão mostrar este pedido no alerta:"
                  : "É um pedido para retirada, sem endereço para marcar. A marca fica no histórico do cliente e aparece no alerta dos próximos pedidos dele."}
            </DialogDescription>
            {!marked && row.address && <div className="rounded-md border border-rule bg-paper px-3 py-2.5 font-medium text-ink">{row.address}</div>}
            {error && (
              <p role="alert" className="text-[12px] text-tomate">
                Não foi possível salvar. Confira a conexão e tente de novo.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-rule px-5 py-3">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Voltar
            </Button>
            <Button variant="accent" onClick={confirm}>
              {marked ? "Remover marca" : "Marcar como fraude"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}

/** Bloco "Cancelamentos" no cadastro do cliente: a mesma lista do alerta, com os totais por origem e as marcas de fraude. */
export function CustomerCancellationsCard({ cancellations }: { cancellations: CustomerCancellations }) {
  const { canceledCount, ordersCount, fraudCount, bySource } = cancellations;
  return (
    <section aria-label="Cancelamentos" className="mb-5 rounded-xl border border-rule bg-surface">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-rule-soft px-4 py-3">
        <h3 className="m-0 font-heading text-[15px] font-semibold">Cancelamentos</h3>
        <span className="text-[12px] text-ink-3 tabular-nums">
          {count(canceledCount)} de {plural(ordersCount, "pedido", "pedidos")}
        </span>
        {fraudCount > 0 && <FraudBadge>{plural(fraudCount, "marcado como fraude", "marcados como fraude")}</FraudBadge>}
        <span className="ml-auto flex items-center gap-3 text-[12px] text-ink-2">
          {bySource.map((source) => (
            <span key={source.channelType} className="flex items-center gap-[5px] tabular-nums">
              <span className={cn("size-2 rounded-full", CHANNEL_DOT[source.channelType])} />
              {CHANNEL_LABEL[source.channelType]} {count(source.orders)}
            </span>
          ))}
        </span>
      </div>
      {canceledCount === 0 ? (
        <div className="px-4 py-5 text-center">
          <div className="font-medium">Nenhum cancelamento</div>
          <p className="m-0 mt-0.5 text-[12px] text-ink-3">Quando um pedido deste cliente for cancelado, ele aparece aqui com a data, a origem e o motivo.</p>
        </div>
      ) : (
        <div className="p-3">
          <CancellationTable cancellations={cancellations} limit={4} />
        </div>
      )}
    </section>
  );
}
