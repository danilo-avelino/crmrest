"use client";

import { CHANNEL_LABEL, type OrderListItem, type OrderPage, type ReportPeriod } from "@dishdesk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ORDER_TONE } from "@/components/clients/client-detail";
import { CHANNEL_DOT, StatusBadge } from "@/components/inbox/bits";
import { ORDER_STATUS } from "@/components/inbox/order-card";
import { CustomerHistoryLine } from "@/components/orders/customer-history";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNow } from "@/hooks/use-now";
import { clock, count, currency, dayTime, responseTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Status = OrderListItem["status"];
type Channel = OrderListItem["channelType"];

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
];
const ORIGINS: Channel[] = ["IFOOD", "CARDAPIO_WEB"];

/** Eventos da plataforma mostrados na linha do tempo do pedido (os demais ficam só no banco). */
const EVENT_LABEL: Record<string, string> = {
  PLACED: "Pedido feito",
  CONFIRMED: "Confirmado",
  PREPARATION_STARTED: "Preparo iniciado",
  READY_TO_PICKUP: "Pronto",
  DISPATCHED: "Saiu para entrega",
  COLLECTED: "Entregador coletou",
  DELIVERED: "Entregue",
  CONCLUDED: "Concluído",
  CANCELLED: "Cancelado",
};

/**
 * Aba Pedidos (versão simples; o design ainda não tem este board): pedidos das integrações sem abrir uma conversa para
 * cada um, com a linha do tempo e o tempo de preparo. Cabeçalho e tabela seguem o board Clientes. Desktop no MVP.
 */
export function OrderList() {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const [period, setPeriod] = useState<ReportPeriod>("today");
  const [status, setStatus] = useState<Status | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const now = useNow(60_000);

  const params = new URLSearchParams({ period, page: String(page), ...(status && { status }), ...(channel && { channel }) });
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

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <header className="shrink-0 border-b border-rule-soft px-7 pt-5">
        <div className="mb-4">
          <h1 className="mb-[3px] font-heading text-[21px] leading-tight font-bold tracking-[-0.3px]">Pedidos</h1>
          <span className="text-xs text-ink-3 tabular-nums">
            {data ? `${count(data.total)} ${data.total === 1 ? "pedido" : "pedidos"} no período` : " "}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 pb-3">
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
              {channel ? CHANNEL_LABEL[channel] : "Origem"}
              <ChevronDownIcon className="size-2.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-48">
              <DropdownMenuRadioGroup value={channel ?? ""} onValueChange={(value: string) => filter(setChannel)((value || null) as Channel | null)}>
                <DropdownMenuRadioItem value="">Todas</DropdownMenuRadioItem>
                {ORIGINS.map((key) => (
                  <DropdownMenuRadioItem key={key} value={key}>
                    <span className={cn("size-2 rounded-full", CHANNEL_DOT[key])} />
                    {CHANNEL_LABEL[key]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
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
              </tr>
            </thead>
            <tbody>
              {data!.items.map((order) => {
                const open = expanded === order.id;
                return (
                  <Fragment key={order.id}>
                    <tr
                      onClick={() => setExpanded(open ? null : order.id)}
                      aria-expanded={open}
                      className={cn("cursor-pointer border-b border-rule-soft", open ? "bg-tomate-lt" : "hover:bg-paper")}
                    >
                      <Td className="font-medium">#{order.displayCode ?? order.id.slice(0, 6)}</Td>
                      <Td>
                        <span className="flex items-center gap-[5px] text-ink-2">
                          <span className={cn("size-2 rounded-full", CHANNEL_DOT[order.channelType])} />
                          {CHANNEL_LABEL[order.channelType]}
                        </span>
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
                          {order.history.orders <= 1 ? "primeiro pedido" : `${count(order.history.orders)} pedidos`}
                        </div>
                      </Td>
                      {master && <Td className="text-ink-2">{order.tenant.name}</Td>}
                      <Td className="text-ink-2">{dayTime(order.placedAt, now)}</Td>
                      <Td align="right" className="text-ink-2">
                        {order.preparationSeconds === null ? "—" : responseTime(order.preparationSeconds)}
                      </Td>
                      <Td className="text-ink-2">{order.dispatchedAt ? clock(order.dispatchedAt) : "—"}</Td>
                      <Td align="right">{currency(order.total)}</Td>
                      <Td>
                        <StatusBadge tone={ORDER_TONE[order.status]}>{ORDER_STATUS[order.status].label}</StatusBadge>
                      </Td>
                    </tr>
                    {open && (
                      <tr className="border-b border-tomate-line bg-tomate-lt">
                        <td colSpan={master ? 9 : 8} className="px-7 pb-4">
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

/** Itens e linha do tempo do pedido (como a plataforma informou). */
function OrderDetails({ order }: { order: OrderListItem }) {
  const timeline = order.events.filter((event) => EVENT_LABEL[event.code]);
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <CustomerHistoryLine history={order.history} />
      </div>
      <div className="overflow-hidden rounded-[7px] border border-tomate-line bg-surface text-xs">
        {order.items.map((item, index) => (
          <div key={index} className="flex justify-between border-b border-surface-2 px-3.5 py-2.5">
            <span className="text-ink-2">
              {item.quantity}× {item.name}
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
                <span className="text-ink-2">{EVENT_LABEL[event.code]}</span>
                <span className="text-ink-3 tabular-nums">{clock(event.occurredAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
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
        "border-b border-rule-soft px-3 py-2.5 text-[11px] font-medium tracking-[0.05em] whitespace-nowrap text-ink-3 uppercase first:pl-7 last:pr-7",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className, align = "left" }: { children: React.ReactNode; className?: string; align?: "left" | "right" }) {
  return (
    <td className={cn("px-3 py-2.5 text-[13px] tabular-nums first:pl-7 last:pr-7", align === "right" && "text-right", className)}>
      {children}
    </td>
  );
}
