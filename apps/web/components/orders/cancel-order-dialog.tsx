"use client";

import { CHANNEL_LABEL, type OrderCancellationOptions, type OrderDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2Icon, LoaderCircleIcon } from "lucide-react";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Modal "Cancelar pedido". iFood: escolha obrigatória entre os motivos que ele oferece para o pedido, e o resultado vem
 * depois (a janela mostra a espera). Cardápio Web: motivo em texto, opcional, e a API confirma na hora. Nos dois, a marca
 * de fraude vem desligada: marcar é decisão do atendente.
 */
export function CancelOrderDialog({
  order,
  open,
  onOpenChange,
  onDone,
}: {
  order: Pick<OrderDto, "id" | "displayCode" | "channelType">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** O cancelamento foi aceito (ou, no iFood, enviado). */
  onDone: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[440px]">
        {/* Só existe com a janela aberta: cada abertura começa do zero, com os motivos da etapa atual do pedido. */}
        {open && <CancelOrderBody order={order} onClose={() => onOpenChange(false)} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function CancelOrderBody({
  order,
  onClose: close,
  onDone,
}: {
  order: Pick<OrderDto, "id" | "displayCode" | "channelType">;
  onClose: () => void;
  onDone: () => void;
}) {
  const { request } = useAuth();
  const id = useId();
  const [code, setCode] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [markFraud, setMarkFraud] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const options = useQuery({
    queryKey: ["cancellation-options", order.id],
    queryFn: () => request<OrderCancellationOptions>(`/orders/${order.id}/cancellation-reasons`),
    retry: false,
    // Os motivos mudam com a etapa do pedido: a cada abertura, de novo.
    gcTime: 0,
    staleTime: 0,
  });

  const label = CHANNEL_LABEL[order.channelType];
  const title = `Cancelar o pedido ${label} #${order.displayCode ?? order.id.slice(0, 6)}?`;
  const data = options.data;
  const list = data?.reasonMode === "list";

  const confirm = async () => {
    setRefused(null);
    try {
      await request(`/orders/${order.id}/cancel`, {
        method: "POST",
        body: { ...(list ? { code } : reason.trim() ? { reason: reason.trim() } : {}), markFraud },
      });
      onDone();
      if (list) setSent(true);
      else close();
    } catch (failure) {
      setRefused(failure instanceof ApiError ? failure.message : `Não foi possível falar com o ${label}. O pedido continua ativo.`);
    }
  };

  return (
    <>
        {sent ? (
          <>
            <div className="flex flex-col gap-1 px-5 pt-[18px]">
              <DialogTitle className="text-[16px]">Cancelamento pedido</DialogTitle>
            </div>
            <div className="px-5 py-3.5">
              <div className="flex items-start gap-2 rounded-md border border-success-line bg-success-lt px-3 py-2.5 text-[12.5px] text-success-ink">
                <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <DialogDescription className="text-success-ink">
                  <strong className="font-semibold">Cancelamento pedido, aguardando o {label}.</strong> Ele costuma responder em até 1 minuto. Você pode fechar
                  esta janela: o resultado aparece na conversa.
                </DialogDescription>
              </div>
            </div>
            <Footer>
              <Button variant="outline" onClick={close}>
                Fechar
              </Button>
            </Footer>
          </>
        ) : options.isError ? (
          <>
            <Header title={title} />
            <div className="px-5 py-3.5">
              <ErrorBox>Não conseguimos carregar os motivos do {label}. O pedido continua ativo.</ErrorBox>
            </div>
            <Footer>
              <Button variant="outline" onClick={close}>
                Voltar
              </Button>
              <Button onClick={() => options.refetch()}>Tentar de novo</Button>
            </Footer>
          </>
        ) : data && list && data.reasons.length === 0 ? (
          <>
            <Header title="Não dá para cancelar agora" />
            <div className="px-5 py-3.5">
              <div className="rounded-md border border-dashed border-tag-line bg-warning-lt px-3 py-2.5 text-[12.5px] text-warning-ink">
                <DialogDescription className="text-warning-ink">
                  O {label} não aceita o cancelamento deste pedido neste momento. Isso acontece, por exemplo, depois que o pedido sai para entrega. Tente de novo
                  em alguns minutos ou cancele no Gestor de Pedidos do {label}.
                </DialogDescription>
              </div>
            </div>
            <Footer>
              <Button variant="outline" onClick={close}>
                Fechar
              </Button>
            </Footer>
          </>
        ) : (
          <>
            <Header title={title}>{list ? `Escolha o motivo. O ${label} só aceita os motivos da lista.` : `O pedido é cancelado também no ${label}.`}</Header>
            <div className="flex max-h-[60vh] flex-col gap-3.5 overflow-y-auto px-5 py-3.5">
              {refused && <ErrorBox>{refused}</ErrorBox>}
              {!data ? (
                <div className="flex flex-col gap-1.5" aria-busy>
                  <span className="font-medium">Motivo do cancelamento</span>
                  <span className="flex items-center gap-2 text-ink-3">
                    <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                    Carregando…
                  </span>
                </div>
              ) : (
                <>
                  {list ? (
                    <div role="radiogroup" aria-label="Motivo do cancelamento" className="flex flex-col gap-1.5">
                      <span className="font-medium">Motivo do cancelamento</span>
                      {data.reasons.map((item) => (
                        <label
                          key={item.code}
                          className={cn(
                            "flex cursor-pointer items-center gap-2.5 rounded-md border bg-surface px-2.5 py-2 has-focus-visible:ring-3 has-focus-visible:ring-ring/8",
                            code === item.code ? "border-ink" : "border-rule hover:bg-paper",
                          )}
                        >
                          <input
                            type="radio"
                            name={`${id}-reason`}
                            checked={code === item.code}
                            onChange={() => setCode(item.code)}
                            className="size-4 accent-ink"
                          />
                          {item.description}
                        </label>
                      ))}
                      {!code && <p className="m-0 text-[12px] text-ink-3">Escolha um motivo para continuar.</p>}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`${id}-text`} className="font-medium">
                        Motivo <span className="font-normal text-ink-3">(opcional)</span>
                      </label>
                      <textarea
                        id={`${id}-text`}
                        value={reason}
                        maxLength={200}
                        onChange={(event) => setReason(event.target.value)}
                        className="h-16 resize-none rounded-lg border border-rule bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-ink focus:ring-3 focus:ring-ring/8"
                      />
                    </div>
                  )}
                  <label className="flex cursor-pointer items-start gap-[9px]">
                    <input
                      type="checkbox"
                      checked={markFraud}
                      onChange={(event) => setMarkFraud(event.target.checked)}
                      className="mt-0.5 size-4 shrink-0 accent-tomate"
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">Marcar como fraude</span>
                      <span className="text-[12px] text-ink-2">
                        {data.address
                          ? `Os próximos pedidos para ${data.address} vão mostrar este pedido no alerta.`
                          : "Pedido para retirada: não tem endereço para marcar. A marca fica no histórico do cliente."}
                      </span>
                    </span>
                  </label>
                  <div className="flex flex-col gap-1.5">
                    <span className="font-medium">Mensagem ao cliente</span>
                    {data.message ? (
                      <>
                        <div className="rounded-md border border-rule bg-paper px-3 py-2.5 whitespace-pre-wrap text-ink-2">{data.message.text}</div>
                        <span className="text-[12px] text-ink-3">
                          Vai pelo {data.message.via}, no tom {data.message.tone}
                          {list ? ", quando o iFood confirmar." : "."}
                        </span>
                      </>
                    ) : (
                      <span className="text-[12px] text-ink-3">Sem conversa com o cliente: o cancelamento não envia mensagem.</span>
                    )}
                  </div>
                  {!list && <p className="m-0 text-[12px] text-ink-3">Depois de confirmado, o cancelamento não pode ser desfeito.</p>}
                </>
              )}
            </div>
            <Footer>
              <Button variant="outline" onClick={close}>
                {refused ? "Fechar" : "Voltar"}
              </Button>
              <Button variant="accent" disabled={!data || (list && !code)} onClick={confirm}>
                {refused ? "Tentar de novo" : "Cancelar pedido"}
              </Button>
            </Footer>
          </>
        )}
    </>
  );
}

function Header({ title, children }: { title: string; children?: string }) {
  return (
    <div className="flex flex-col gap-1 px-5 pt-[18px]">
      <DialogTitle className="text-[16px]">{title}</DialogTitle>
      {children && <DialogDescription className="text-ink-2">{children}</DialogDescription>}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 border-t border-rule px-5 py-3">{children}</div>;
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-tomate-line bg-tomate-lt px-3 py-2.5 text-[12.5px] text-tomate-ink">
      {children}
    </div>
  );
}
