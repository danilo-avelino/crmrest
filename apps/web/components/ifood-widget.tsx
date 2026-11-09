"use client";

import type { IfoodWidgetDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import Script from "next/script";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useIfoodChat } from "@/hooks/use-ifood-chat";
import { setIfoodWidgetChoice, useIfoodWidgetChoice } from "@/lib/ifood-widget-choice";

/** API JavaScript oficial do widget (https://developer.ifood.com.br → Soluções → Widget). */
type IfoodWidgetApi = {
  init(config: { widgetId: string; merchantIds: string[]; autoShow?: boolean }): Promise<void>;
  show(): void;
  hide(): void;
  ready: Promise<void>;
};

declare global {
  interface Window {
    iFoodWidget?: IfoodWidgetApi;
  }
}

export const IFOOD_WIDGET_KEY = ["ifood-widget"] as const;

/** Widget do iFood do usuário: as lojas e se o chat dele vai para a Inbox (trava IFOOD_CHAT_BRIDGE da API). */
export function useIfoodWidget() {
  const { session, request } = useAuth();
  return useQuery({
    queryKey: IFOOD_WIDGET_KEY,
    queryFn: () => request<IfoodWidgetDto>("/ifood-widget"),
    enabled: Boolean(session?.accessToken),
    staleTime: Infinity,
  });
}

/**
 * Widget oficial do iFood (chat com o cliente, notificações e status da loja), em todas as telas depois de escolher o
 * restaurante. Liga sozinho quando o restaurante integra a primeira loja iFood. O iFood não tem API de chat: as
 * mensagens ficam no widget, fora do histórico do Dish Desk, a não ser com a trava do chat ligada (useIfoodChat).
 */
export function IfoodWidget() {
  const { session } = useAuth();
  const config = useIfoodWidget();
  // Só carrega no computador que disse "Sim": no que não atende, o pedido de autorização do iFood não atrapalha.
  const choice = useIfoodWidgetChoice();
  const [loaded, setLoaded] = useState(false);
  // Lojas com que o widget foi iniciado. Uma inicialização por página: o widget apaga a autorização da loja quando as
  // lojas do init mudam, por isso a API manda as de todos os restaurantes do usuário, as mesmas em qualquer contexto.
  const initialized = useRef<string | null>(null);
  // O widget está na tela com as lojas do usuário atual.
  const [shown, setShown] = useState(false);
  const data = session?.accessToken ? config.data : undefined;
  const key = data?.widgetId && data.merchantIds.length ? `${data.widgetId}:${[...data.merchantIds].sort().join(",")}` : null;

  useEffect(() => {
    const widget = window.iFoodWidget;
    if (!loaded || !widget) return;
    if (key && data?.widgetId && !initialized.current) {
      initialized.current = key;
      void widget.init({ widgetId: data.widgetId, merchantIds: data.merchantIds, autoShow: false });
    }
    // Lojas diferentes das iniciadas (saiu, entrou outro usuário ou mudou as lojas): esconde até recarregar a página,
    // para nunca mostrar o chat de outra loja.
    void widget.ready.then(() => {
      const current = key !== null && key === initialized.current;
      if (current) widget.show();
      else widget.hide();
      setShown(current);
    });
  }, [loaded, key, data]);
  const chat = useIfoodChat(shown && data?.chat === true);

  // O script fica na página depois de carregado uma vez (para conseguir esconder o widget ao sair).
  const [needed, setNeeded] = useState(false);
  if (key && choice === "on" && !needed) setNeeded(true);
  if (!needed) return key && choice === "ask" ? <IfoodWidgetPrompt /> : null;
  return (
    <>
      <Script src="https://widgets.ifood.com.br/widget.js" strategy="afterInteractive" onReady={() => setLoaded(true)} />
      {/* O motor do chat mantém o widget aberto na aba Chat: invisível e sem cliques, para não cobrir o painel. */}
      {chat === "driving" && <style>{'iframe[src^="https://embeddables.ifood.com.br"]{opacity:0!important;pointer-events:none!important}'}</style>}
      {/* O convite de autorização foi aberto pelo motor, fora das áreas de clique que o widget marca: sem isto, o clique cai no painel. */}
      {chat === "unauthorized" && <style>{'iframe[src^="https://embeddables.ifood.com.br"]{pointer-events:all!important}'}</style>}
    </>
  );
}

/**
 * Pergunta do Dish Desk antes de carregar o widget do iFood neste computador. "Não" volta a perguntar ao abrir o painel
 * de novo, a não ser com "Não perguntar de novo"; o atendimento religa na Inbox (Integrações). O design ainda não tem
 * este modal: segue os modais do board Clientes → LGPD. Desktop no MVP.
 */
function IfoodWidgetPrompt() {
  const id = useId();
  const [never, setNever] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && setIfoodWidgetChoice("later")}>
      <DialogContent className="w-[460px]">
        <div className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="mb-1">Usar o widget do iFood neste computador?</DialogTitle>
          <DialogDescription>Chat com o cliente, notificações e status da loja do iFood dentro do Dish Desk.</DialogDescription>
        </div>
        <div className="flex flex-col gap-4 px-6 py-[18px]">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Para funcionar, o iFood pede que a loja autorize o widget neste computador, pelo Portal do Parceiro. Nos computadores
            que não atendem os pedidos (como o da administração), pode deixar desligado: o resto do Dish Desk funciona igual.
          </p>
          <label htmlFor={`${id}-never`} className="flex items-center gap-2.5 text-[13px]">
            <input
              id={`${id}-never`}
              type="checkbox"
              className="size-4 shrink-0 accent-ink"
              checked={never}
              onChange={(event) => setNever(event.target.checked)}
            />
            Não perguntar de novo neste computador
          </label>
          <div className="flex gap-2">
            <Button disabled={never} title={never ? "Desmarque para usar o widget" : undefined} onClick={() => setIfoodWidgetChoice("on")}>
              Sim, usar o widget
            </Button>
            <Button variant="outline" onClick={() => setIfoodWidgetChoice(never ? "off" : "later")}>
              Não
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
