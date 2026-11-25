"use client";

import { type OrderListItem, type OrderPage, type OrderStageCounts, type ReportPeriod, ORDER_ORIGIN_LABEL } from "@dishdesk/shared";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, ChevronDownIcon, ClockIcon, ShieldAlertIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { CHANNEL_DOT, StatusBadge } from "@/components/common/bits";
import { ORDER_STATUS, OrderTrack, orderStep } from "@/components/orders/order-status";
import { CustomerHistoryLine } from "@/components/orders/customer-history";
import { FraudAlert, FraudBadge, FraudMarkControl } from "@/components/orders/fraud-alert";
import { ItemOptions } from "@/components/orders/item-options";
import { ACTION_LABEL, OrderActions } from "@/components/orders/order-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { clock, count, currency, dayMonth, dayTime, responseTime } from "@/lib/format";
import { MENU_ORIGIN_LABEL, menuBadges, parseMenuItemName } from "@/lib/menu-order";
import { cn } from "@/lib/utils";

type Status = OrderListItem["status"];
type Channel = OrderListItem["channelType"];

const PERIODS: { value: ReportPeriod; label: string; title: string }[] = [
  { value: "today", label: "Hoje", title: "Hoje" },
  { value: "7d", label: "7 dias", title: "Últimos 7 dias" },
  { value: "30d", label: "30 dias", title: "Últimos 30 dias" },
];
const ORIGINS: Channel[] = ["IFOOD", "CARDAPIO_WEB", "NEEMO"];

/** Eventos da plataforma mostrados na linha do tempo do pedido (os demais ficam só no banco). */
const EVENT_LABEL: Record<string, string> = {
  PLACED: "Pedido feito",
  CONFIRMED: "Confirmado",
  PREPARATION_STARTED: "Preparo iniciado",
  READY_TO_PICKUP: "Pronto",
  DISPATCHED: "Saiu para entrega",
  COLLECTED: "Entregador coletou",
  DELIVERED: "Entregue",
  DELIVERY_DROP_CODE_VALIDATION_SUCCESS: "Entregue (código confirmado)",
  CONCLUDED: "Concluído",
  CANCELLATION_REQUESTED: "Cancelamento pedido",
  CANCELLATION_REQUEST_FAILED: "Cancelamento não aceito pelo iFood",
  HANDSHAKE_DISPUTE: "Cliente pediu cancelamento",
  HANDSHAKE_SETTLEMENT: "Resposta ao cliente",
  CANCELLED: "Cancelado",
};

const PAYMENT_METHOD: Record<string, string> = {
  CREDIT: "Crédito",
  DEBIT: "Débito",
  CASH: "Dinheiro",
  PIX: "Pix",
  PIX_ON_DELIVERY: "Pix na maquininha",
  MEAL_VOUCHER: "Vale-refeição",
  FOOD_VOUCHER: "Vale-alimentação",
  DIGITAL_WALLET: "Carteira digital",
  GIFT_CARD: "Gift card",
};
/** Quem paga o cupom. */
const SPONSOR: Record<string, string> = { IFOOD: "iFood", MERCHANT: "loja" };

/**
 * Aba Pedidos (board Pedidos do Dish Desk Design): o total do período domina, com o filtro de período dentro do bloco;
 * "Agora na cozinha" fica ao lado porque não muda com o período. Embaixo, a lista com os filtros dela (status, origem,
 * agendados), a trilha de etapas, a próxima etapa num botão na própria linha e os avisos colados no pedido. Desktop no MVP.
 */
export function OrderList() {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const [period, setPeriod] = useState<ReportPeriod>("today");
  const [status, setStatus] = useState<Status | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const now = useNow(60_000);

  const params = new URLSearchParams({ period, page: String(page), ...(status && { status }), ...(channel && { channel }), ...(scheduled && { scheduled: "true" }) });
  const orders = useQuery({
    queryKey: ["orders", params.toString()],
    queryFn: () => request<OrderPage>(`/orders?${params}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000, // os pedidos chegam pelo polling das integrações
  });
  const filter = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };
  const data = orders.data;
  const summary = data?.summary;
  const sold = summary ? summary.orders - summary.canceled : 0;
  const columns = master ? 10 : 9;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-[18px] px-7 pt-5 pb-6">
          <h1 className="font-heading text-[21px] leading-tight font-bold tracking-[-0.3px]">Pedidos</h1>

          <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-3">
            <section aria-label="Pedidos no período" className="min-w-0 rounded-xl border border-rule p-4">
              <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11.5px] font-medium text-ink-3">Pedidos · {PERIODS.find((item) => item.value === period)!.title}</span>
                <div className="flex flex-wrap gap-1">
                  {PERIODS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={period === item.value}
                      onClick={() => filter(setPeriod)(item.value)}
                      className={chipClass(period === item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="font-heading text-[48px] leading-none font-bold tracking-[-1px] tabular-nums">{summary ? count(summary.orders) : "–"}</div>
              <div className="mt-3.5 flex flex-wrap gap-x-[26px] gap-y-2 border-t border-rule-soft pt-3">
                <Figure value={summary ? currency(summary.sales) : "–"} label="em vendas" />
                <Figure value={summary ? currency(sold > 0 ? Number(summary.sales) / sold : 0) : "–"} label="por pedido" />
                <Figure value={summary ? count(summary.canceled) : "–"} label={summary?.canceled === 1 ? "cancelado" : "cancelados"} />
              </div>
            </section>
            <KitchenNow />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={scheduled} onClick={() => filter(setScheduled)(!scheduled)} className={chipClass(scheduled)}>
                Agendados
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger className={chipClass(Boolean(status))}>
                  {status ? ORDER_STATUS[status].label : "Status"}
                  <ChevronDownIcon className="size-2.5" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-48">
                  <DropdownMenuRadioGroup value={status ?? ""} onValueChange={(value: string) => filter(setStatus)((value || null) as Status | null)}>
                    <DropdownMenuRadioItem value="">Todos</DropdownMenuRadioItem>
                    {(Object.keys(ORDER_STATUS) as Status[]).map((key) => (
                      <DropdownMenuRadioItem key={key} value={key}>
                        {ORDER_STATUS[key].label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger className={chipClass(Boolean(channel))}>
                  {channel ? ORDER_ORIGIN_LABEL[channel] : "Origem"}
                  <ChevronDownIcon className="size-2.5" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-48">
                  <DropdownMenuRadioGroup value={channel ?? ""} onValueChange={(value: string) => filter(setChannel)((value || null) as Channel | null)}>
                    <DropdownMenuRadioItem value="">Todas</DropdownMenuRadioItem>
                    {(data?.menuOrigin || channel === "MENU" ? (["MENU", ...ORIGINS] as Channel[]) : ORIGINS).map((key) => (
                      <DropdownMenuRadioItem key={key} value={key}>
                        <span className={cn("size-2 rounded-full", CHANNEL_DOT[key])} />
                        {ORDER_ORIGIN_LABEL[key]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <span className="text-xs text-ink-3 tabular-nums">
              {data ? `${count(data.total)} ${data.total === 1 ? "pedido" : "pedidos"} na lista` : " "}
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-rule">
            {orders.isPending ? (
              <p className="px-7 py-6 text-[13px] text-ink-3" aria-busy>
                Carregando…
              </p>
            ) : orders.isError ? (
              <div className="p-7">
                <div className="flex max-w-lg items-start gap-3 rounded-xl border border-tomate-line bg-tomate-lt p-5">
                  <AlertCircleIcon className="mt-px size-[18px] shrink-0 text-tomate" aria-hidden />
                  <div>
                    <div className="mb-1 text-[13px] font-medium">Não foi possível carregar os pedidos</div>
                    <div className="mb-2.5 text-xs text-ink-3">Verifique sua conexão e tente novamente.</div>
                    <Button variant="outline" size="sm" onClick={() => orders.refetch()}>
                      Tentar novamente
                    </Button>
                  </div>
                </div>
              </div>
            ) : data!.items.length === 0 ? (
              <p className="px-7 py-16 text-center text-[13px] text-ink-3">Nenhum pedido no período.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-paper">
                    <Th>Pedido</Th>
                    <Th>Origem</Th>
                    <Th>Cliente</Th>
                    {master && <Th>Restaurante</Th>}
                    <Th>Feito em</Th>
                    <Th align="right">Preparo</Th>
                    <Th>Saída</Th>
                    <Th align="right">Total</Th>
                    <Th>Status</Th>
                    <Th>
                      <span className="sr-only">Próxima etapa</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {data!.items.map((order) => {
                    const open = expanded === order.id;
                    const step = orderStep(order);
                    const alert = order.alert?.level === "HIGH" && !order.alert.decision ? order.alert : null;
                    const toggle = () => setExpanded(open ? null : order.id);
                    return (
                      <Fragment key={order.id}>
                        <tr
                          onClick={toggle}
                          aria-expanded={open}
                          className={cn(
                            "cursor-pointer",
                            // Com aviso, a linha do aviso fecha o pedido; sem aviso, a borda fica na própria linha.
                            !open && (alert || order.late) ? "" : "border-b border-rule-soft",
                            open ? "bg-tomate-lt" : "hover:bg-paper",
                          )}
                        >
                          <Td className="font-medium">
                            <span className="flex items-center gap-1.5">
                              #{order.displayCode ?? order.id.slice(0, 6)}
                              {order.alert && !order.alert.decision && <FraudBadge>Alerta</FraudBadge>}
                            </span>
                          </Td>
                          <Td>
                            <span className="flex items-center gap-[5px] text-ink-2">
                              <span className={cn("size-2 rounded-full", CHANNEL_DOT[order.channelType])} />
                              {ORDER_ORIGIN_LABEL[order.channelType]}
                            </span>
                            <MenuBadges order={order} now={new Date(now)} />
                          </Td>
                          <Td>
                            <Link
                              href={`/clientes/${order.contact.id}`}
                              onClick={(event) => event.stopPropagation()}
                              className="hover:text-tomate hover:underline"
                            >
                              {order.contact.name ?? "Cliente sem nome"}
                            </Link>
                            <div className="text-[11px] text-ink-3">
                              {order.customerCanceled > 0
                                ? // Como no alerta: "4 cancelados de 9 feitos".
                                  `${count(order.history.orders + order.customerCanceled)} pedidos · ${count(order.customerCanceled)} ${order.customerCanceled === 1 ? "cancelado" : "cancelados"}`
                                : order.history.orders <= 1
                                  ? "primeiro pedido"
                                  : `${count(order.history.orders)} pedidos`}
                            </div>
                          </Td>
                          {master && <Td className="text-ink-2">{order.tenant.name}</Td>}
                          <Td className="text-ink-2">{dayTime(order.placedAt, now)}</Td>
                          <Td align="right" className="text-ink-2">
                            {order.preparationSeconds === null ? "—" : responseTime(order.preparationSeconds)}
                            {order.readySkipped && (
                              <div className="text-[11px] text-ink-3" title="A loja não marcou o pedido como pronto: o preparo foi contado até a saída.">
                                interação manual
                              </div>
                            )}
                          </Td>
                          <Td className="text-ink-2">
                            {order.takeout ? (
                              <StatusBadge tone="neutral">Retirada</StatusBadge>
                            ) : order.dispatchedAt ? (
                              clock(order.dispatchedAt)
                            ) : (
                              "—"
                            )}
                          </Td>
                          <Td align="right">{currency(order.total)}</Td>
                          <Td className="w-[148px]">
                            <OrderTrack status={step} late={order.late} />
                            <div className={cn("mt-[3px] text-xs", order.late ? "font-medium text-tomate" : "text-ink-2")}>
                              {ORDER_STATUS[step].label}
                              {order.late && " · atrasado"}
                            </div>
                            {order.dispute && <div className="mt-0.5 text-[11px] text-warning">Cliente pediu cancelamento</div>}
                          </Td>
                          {/* O clique no botão não abre o pedido. */}
                          <td className="px-3 py-2.5 text-right last:pr-4" onClick={(event) => event.stopPropagation()}>
                            <NextStep order={order} />
                          </td>
                        </tr>
                        {!open && (alert || order.late) && (
                          <tr className="border-b border-rule-soft">
                            <td colSpan={columns} className="px-4 pb-2.5">
                              {alert ? (
                                <ItemNote tone="danger" icon={<ShieldAlertIcon className="size-3.5" aria-hidden />} action="Ver e decidir" onAction={toggle}>
                                  <strong className="font-semibold">Alerta de fraude.</strong>{" "}
                                  <span className="tabular-nums">
                                    {count(alert.cancellations.canceledCount)} de {count(alert.cancellations.ordersCount)}
                                  </span>{" "}
                                  pedidos deste cliente foram cancelados.
                                </ItemNote>
                              ) : (
                                <ItemNote tone="warn" icon={<ClockIcon className="size-3.5" aria-hidden />} action="Ver pedido" onAction={toggle}>
                                  <strong className="font-semibold">Atrasado.</strong> O pedido ainda não saiu e já passou do prazo.
                                </ItemNote>
                              )}
                            </td>
                          </tr>
                        )}
                        {open && (
                          <tr className="border-b border-tomate-line bg-tomate-lt">
                            <td colSpan={columns} className="px-4 pb-4">
                              <OrderDetails order={order} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {data && data.total > data.pageSize && (
        <footer className="flex shrink-0 items-center justify-between border-t border-rule-soft px-7 py-3">
          <span className="text-xs text-ink-3 tabular-nums">
            {count((data.page - 1) * data.pageSize + 1)}–{count(Math.min(data.page * data.pageSize, data.total))} de {count(data.total)} pedidos
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
              ← Anterior
            </Button>
            <Button variant="outline" size="sm" disabled={data.page * data.pageSize >= data.total} onClick={() => setPage(data.page + 1)}>
              Próxima →
            </Button>
          </div>
        </footer>
      )}
    </main>
  );
}

/** Itens e linha do tempo do pedido (como a plataforma informou). Também no modal dos pedidos em produção da Inbox. */
export function OrderDetails({ order, withChat = true }: { order: OrderListItem; withChat?: boolean }) {
  const timeline = order.events.filter((event) => EVENT_LABEL[event.code]);
  return (
    <div className="grid grid-cols-2 gap-3">
      {order.alert && (
        <div className="col-span-2">
          <FraudAlert order={order} alert={order.alert} cancelable={order.cancelable} />
        </div>
      )}
      <div className="col-span-2">
        <CustomerHistoryLine history={order.history} />
      </div>
      {order.menu && (
        <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[7px] border border-tomate-line bg-surface px-3.5 py-2.5 text-xs">
          <MenuBadges order={order} now={new Date()} />
          <span className="text-ink-3">
            {order.menu.takeout ? "Retirada na loja" : "Entrega"} · Origem: <span className="text-ink-2">{MENU_ORIGIN_LABEL[order.menu.origin]}</span>
          </span>
        </div>
      )}
      {order.cancellation && (
        <div className="col-span-2 flex flex-col gap-1 rounded-[7px] border border-tomate-line bg-surface px-3.5 py-2.5 text-xs">
          <div className="text-[11px] font-medium tracking-[0.05em] text-ink-3 uppercase">Cancelamento</div>
          <div>
            <span className="font-medium">Motivo:</span> {order.cancellation.reason ?? <span className="text-ink-3 italic">Motivo não informado</span>}
          </div>
          {order.cancellation.outsideAt && (
            <div className="text-[12px] text-ink-3">
              Cancelado no {ORDER_ORIGIN_LABEL[order.channelType]}, fora do Dish Desk, em {dayMonth(order.cancellation.outsideAt)} às {clock(order.cancellation.outsideAt)}.
            </div>
          )}
          <FraudMarkControl row={order.cancellation} />
        </div>
      )}
      <div className="overflow-hidden rounded-[7px] border border-tomate-line bg-surface text-xs">
        {order.items.map((item, index) => (
          <div key={index} className="flex justify-between border-b border-surface-2 px-3.5 py-2.5">
            <span className="text-ink-2">
              {order.menu ? <MenuItemLines quantity={item.quantity} name={item.name} /> : `${item.quantity}× ${item.name}`}
              <ItemOptions options={item.options} />
              {item.notes?.trim() && <span className="block text-[11px] text-ink-3">Obs.: {item.notes}</span>}
            </span>
            <span className="font-medium tabular-nums">{currency(Number(item.unitPrice) * item.quantity)}</span>
          </div>
        ))}
        <div className="flex justify-between bg-paper px-3.5 py-2.5 text-[11.5px] text-ink-3">
          <span>Taxa de entrega</span>
          <span className="tabular-nums">{currency(order.deliveryFee)}</span>
        </div>
      </div>
      <div className="rounded-[7px] border border-tomate-line bg-surface px-3.5 py-2.5 text-xs">
        <div className="mb-1.5 text-[11px] font-medium tracking-[0.05em] text-ink-3 uppercase">Linha do tempo</div>
        {timeline.length === 0 ? (
          <p className="text-ink-3">A plataforma ainda não informou as etapas deste pedido.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {timeline.map((event, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span className="text-ink-2">
                  {EVENT_LABEL[event.code]}
                  {event.detail && <span className="text-ink-3"> · {event.detail}</span>}
                </span>
                <span className="text-ink-3 tabular-nums">{clock(event.occurredAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {order.platform && <PlatformInfo info={order.platform} />}
      <OrderActions order={order} withChat={withChat} />
    </div>
  );
}

/** Selos do pedido do cardápio próprio: pagamento (Pix, na entrega, troco) e agendamento. */
function MenuBadges({ order, now }: { order: OrderListItem; now: Date }) {
  const badges = menuBadges(order.menu, now);
  if (badges.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {badges.map((badge) => (
        <StatusBadge key={badge.key} tone={badge.tone}>
          {badge.label}
        </StatusBadge>
      ))}
    </span>
  );
}

/** Item do cardápio próprio para a cozinha: tamanho em destaque e, no meio a meio, um sabor por linha. */
function MenuItemLines({ quantity, name }: { quantity: number; name: string }) {
  const { size, halves, title } = parseMenuItemName(name);
  return (
    <>
      {quantity}× {halves.length ? "Meio a meio" : title}
      {size && <span className="font-medium text-ink"> · {size}</span>}
      {halves.map((half, index) => (
        <span key={index} className="block text-[12px] text-ink-2">
          ½ {half}
        </span>
      ))}
    </>
  );
}

/** Pagamento (com o troco a levar), cupom e quem paga, código de coleta, documento da nota e observações do pedido. */
function PlatformInfo({ info }: { info: NonNullable<OrderListItem["platform"]> }) {
  const rows: { label: string; value: string }[] = [
    ...info.payments.map((payment) => ({
      label: "Pagamento",
      value: [
        [PAYMENT_METHOD[payment.method] ?? payment.method, payment.brand].filter(Boolean).join(" "),
        currency(payment.value),
        payment.prepaid ? "pago pelo app" : "cobrar na entrega",
        payment.changeFor && `troco para ${currency(payment.changeFor)} (levar ${currency(payment.change!)})`,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    ...info.benefits.map((benefit) => ({
      label: "Cupom",
      value: [
        currency(benefit.value),
        benefit.sponsors.length > 0 &&
          `pago por: ${benefit.sponsors.map((sponsor) => `${SPONSOR[sponsor.name] ?? sponsor.name} ${currency(sponsor.value)}`).join(", ")}`,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    ...(info.pickupCode ? [{ label: "Código de coleta", value: info.pickupCode }] : []),
    ...(info.document ? [{ label: "CPF/CNPJ na nota", value: info.document }] : []),
    ...info.notes.map((note) => ({ label: "Observação", value: note })),
  ];
  if (rows.length === 0) return null;
  return (
    <dl className="col-span-2 rounded-[7px] border border-tomate-line bg-surface px-3.5 py-2.5 text-xs">
      {rows.map((row, index) => (
        <div key={index} className="flex gap-3 py-0.5">
          <dt className="w-32 shrink-0 text-ink-3">{row.label}</dt>
          <dd className="text-ink-2 tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Número secundário do bloco principal: "R$ 2.914,60 em vendas". */
function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <b className="block text-[15px] font-semibold tabular-nums">{value}</b>
      <span className="text-xs text-ink-3">{label}</span>
    </div>
  );
}

/** "Agora na cozinha": as etapas de hoje, fora do bloco do período porque não mudam com ele (a mesma contagem da Inbox). */
function KitchenNow() {
  const { request } = useAuth();
  const stages = useQuery({
    queryKey: ["orders", "stages"],
    queryFn: () => request<OrderStageCounts>("/orders/stages"),
    refetchInterval: 30_000,
  });
  const rows = [
    { label: "Em produção", value: stages.data?.production, status: "PREPARING" },
    { label: "Prontos", value: stages.data?.ready, status: "READY" },
    { label: "Em entrega", value: stages.data?.dispatched, status: "DISPATCHED" },
  ] as const;
  return (
    <section aria-label="Agora na cozinha" className="min-w-0 rounded-xl border border-rule-soft bg-paper p-4">
      <span className="text-[11.5px] font-medium text-ink-3">Agora na cozinha</span>
      <div className="mt-2.5 flex flex-col gap-[9px]">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-[5px]">
            <div className="flex items-center justify-between text-[13px]">
              <span>{row.label}</span>
              <strong className="font-semibold tabular-nums">{row.value === undefined ? "–" : count(row.value)}</strong>
            </div>
            <OrderTrack status={row.status} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Próxima etapa na própria linha (design: "a próxima etapa em um botão na própria linha"), a mesma do botão do pedido
 * aberto. O iFood só aceita o pedido de mudança: até o status mudar, o botão dá lugar a "Enviado ao iFood".
 */
function NextStep({ order }: { order: OrderListItem }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [sentAt, setSentAt] = useState<string | null>(null);
  if (sentAt === order.status) return <span className="text-[11px] whitespace-nowrap text-ink-3">Enviado ao iFood</span>;
  if (!order.nextAction) return null;
  const advance = async () => {
    try {
      await request(`/orders/${order.id}/advance`, { method: "POST" });
      setSentAt(order.status);
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    } catch (failure) {
      toast(failure instanceof ApiError ? failure.message : "Não foi possível falar com o iFood.");
    }
  };
  return (
    <Button variant="outline" size="xs" onClick={advance}>
      {ACTION_LABEL[order.nextAction]}
    </Button>
  );
}

/** Aviso colado no pedido (design: "aviso colado no item a que se refere, com a ação ao lado"). */
function ItemNote({
  tone,
  icon,
  action,
  onAction,
  children,
}: {
  tone: "danger" | "warn";
  icon: React.ReactNode;
  action: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg px-2.5 py-2 text-[12.5px]",
        tone === "danger" ? "bg-tomate-lt text-tomate-ink" : "bg-warning-lt text-warning-ink",
      )}
    >
      <span className="shrink-0 self-start pt-px">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" onClick={onAction} className="text-[12.5px] font-medium underline underline-offset-2">
        {action}
      </button>
    </div>
  );
}

function chipClass(active: boolean): string {
  return cn(
    "inline-flex h-[30px] items-center gap-[5px] rounded-md border px-3 text-xs whitespace-nowrap",
    active ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2 hover:bg-paper",
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={cn(
        "border-b border-rule-soft px-3 py-2.5 text-[11px] font-medium tracking-[0.05em] whitespace-nowrap text-ink-3 uppercase first:pl-4 last:pr-4",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className, align = "left" }: { children: React.ReactNode; className?: string; align?: "left" | "right" }) {
  return (
    <td className={cn("px-3 py-2.5 text-[13px] tabular-nums first:pl-4 last:pr-4", align === "right" && "text-right", className)}>
      {children}
    </td>
  );
}
