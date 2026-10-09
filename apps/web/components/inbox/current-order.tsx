"use client";

import { CHANNEL_LABEL, type CurrentOrderDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-provider";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { ForecastButton, NOTIFIABLE, ORDER_STATUS } from "@/components/inbox/order-card";
import { CustomerHistoryLine } from "@/components/orders/customer-history";
import { useNow } from "@/hooks/use-now";
import { clock, currency, responseTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Pedido ligado ao cliente da conversa (painel lateral; o design ainda não tem este bloco): achado sozinho pelo
 * cadastro ao abrir a conversa, com itens, observações e o andamento até a saída prevista e a entrega prometida.
 */
export function CurrentOrder({ conversationId }: { conversationId: string }) {
  const { request } = useAuth();
  const query = useQuery({
    queryKey: ["current-order", conversationId],
    queryFn: () => request<{ current: CurrentOrderDto | null }>(`/orders/current?conversationId=${conversationId}`),
    refetchInterval: 30_000, // a previsão e o status mudam com a cozinha (as plataformas são consultadas a cada 30s)
  });
  const current = query.data?.current;
  if (!current) return null;
  const { order } = current;
  const status = ORDER_STATUS[order.status];

  return (
    <div className="flex flex-col gap-2.5 border-b border-rule px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Pedido do cliente</div>
        <span className={cn("text-[10.5px] font-medium", status.className)}>{status.label}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
        <span className={cn("size-[7px] shrink-0 rounded-full", CHANNEL_DOT[order.channelType])} />
        {CHANNEL_LABEL[order.channelType]} #{order.displayCode ?? order.id.slice(0, 6)}
        <span className="ml-auto font-normal text-ink-2 tabular-nums">{currency(order.total)}</span>
      </div>

      <CustomerHistoryLine history={current.history} />
      <ul className="flex flex-col gap-1 text-[12.5px]">
        {order.items.map((item, index) => (
          <li key={index}>
            {item.quantity}× {item.name}
            {item.notes && <div className="text-[11px] text-ink-3 italic">Obs.: {item.notes}</div>}
          </li>
        ))}
      </ul>
      {current.notes.length > 0 && (
        <div className="rounded-md border border-warning-line bg-warning-lt px-2.5 py-2 text-[11.5px] text-warning-ink">
          {current.notes.map((note, index) => (
            <div key={index}>{note}</div>
          ))}
        </div>
      )}

      {current.stale ? (
        <p className="text-[11px] text-ink-3">
          Sem atualização da plataforma há mais de 4 h: o status pode estar desatualizado, então não há andamento nem previsão.
        </p>
      ) : (
        order.status !== "CANCELED" && <Progress current={current} />
      )}
      {NOTIFIABLE.has(order.status) && !current.stale && (
        <div className="flex justify-end">
          <ForecastButton order={order} conversationId={conversationId} />
        </div>
      )}
    </div>
  );
}

/**
 * Barra do pedido feito até o fim mais distante (saída prevista, entrega prometida ou agora): o preenchimento é o tempo
 * decorrido (ou até a saída, se já saiu); as marcas são a saída prevista (previsão real) e a entrega prometida.
 */
function Progress({ current }: { current: CurrentOrderDto }) {
  const now = useNow(30_000);
  const { order, forecast } = current;
  const start = Date.parse(order.placedAt);
  const departed = order.dispatchedAt ? Date.parse(order.dispatchedAt) : null;
  const departAt = forecast ? Date.parse(forecast.departAt) : null;
  const promised = current.promisedAt ? Date.parse(current.promisedAt) : null;
  const filledUntil = departed ?? now;
  const end = Math.max(filledUntil, departAt ?? 0, promised ?? 0, start + 60_000);
  const at = (time: number) => `${Math.min(100, Math.max(0, ((time - start) / (end - start)) * 100))}%`;
  const late = Boolean(forecast?.late) || (promised !== null && departed === null && now > promised);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-2 rounded-full bg-surface-2" role="img" aria-label="Andamento do pedido">
        <div className={cn("absolute inset-y-0 left-0 rounded-full", late ? "bg-tomate" : "bg-ink")} style={{ width: at(filledUntil) }} />
        {departAt && <Marker left={at(departAt)} className="bg-warning" />}
        {promised && <Marker left={at(promised)} className="bg-success" />}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px] tabular-nums">
        <dt className="text-ink-3">{departed ? "Saiu em" : "Decorrido"}</dt>
        <dd className="text-right font-medium">{responseTime((filledUntil - start) / 1000)}</dd>
        {departed ? (
          <>
            <dt className="text-ink-3">Saída</dt>
            <dd className="text-right">{clock(order.dispatchedAt!)}</dd>
          </>
        ) : (
          departAt && (
            <>
              <dt className="flex items-center gap-1.5 text-ink-3">
                <span className="size-2 rounded-full bg-warning" />
                Saída prevista
              </dt>
              <dd className={cn("text-right", forecast!.late && "font-medium text-tomate")}>
                {clock(forecast!.departAt)}
                {forecast!.late && " · atrasado"}
              </dd>
            </>
          )
        )}
        {promised && (
          <>
            <dt className="flex items-center gap-1.5 text-ink-3">
              <span className="size-2 rounded-full bg-success" />
              Entrega prometida ({CHANNEL_LABEL[order.channelType]})
            </dt>
            <dd className="text-right">{clock(current.promisedAt!)}</dd>
          </>
        )}
        {!departed && !departAt && (
          <dd className="col-span-2 text-ink-3">Sem previsão de saída: ainda não há pedidos que saíram para servir de base.</dd>
        )}
      </dl>
    </div>
  );
}

function Marker({ left, className }: { left: string; className: string }) {
  return <span className={cn("absolute -top-1 h-4 w-[3px] -translate-x-1/2 rounded-sm", className)} style={{ left }} aria-hidden />;
}
