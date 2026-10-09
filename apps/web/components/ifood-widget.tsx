"use client";

import type { IfoodWidgetDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";

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

/**
 * Widget oficial do iFood (chat com o cliente, notificações e status da loja), em todas as telas depois de escolher o
 * restaurante. Liga sozinho quando o restaurante integra a primeira loja iFood. O iFood não tem API de chat: as
 * mensagens ficam no widget, fora do histórico do Dish Desk.
 */
export function IfoodWidget() {
  const { session, request } = useAuth();
  const config = useQuery({
    queryKey: IFOOD_WIDGET_KEY,
    queryFn: () => request<IfoodWidgetDto>("/ifood-widget"),
    enabled: Boolean(session?.accessToken),
    staleTime: Infinity,
  });
  const [loaded, setLoaded] = useState(false);
  // Lojas com que o widget foi iniciado. Uma inicialização por página: iniciar de novo com outros parâmetros derruba a
  // autorização da loja no widget.
  const initialized = useRef<string | null>(null);
  const data = session?.accessToken ? config.data : undefined;
  const key = data?.widgetId && data.merchantIds.length ? `${data.widgetId}:${[...data.merchantIds].sort().join(",")}` : null;

  useEffect(() => {
    const widget = window.iFoodWidget;
    if (!loaded || !widget) return;
    if (key && data?.widgetId && !initialized.current) {
      initialized.current = key;
      void widget.init({ widgetId: data.widgetId, merchantIds: data.merchantIds, autoShow: false });
    }
    // Lojas diferentes das iniciadas (saiu, trocou de restaurante ou mudou as lojas): esconde até recarregar a página,
    // para nunca mostrar o chat de outra loja.
    void widget.ready.then(() => (key && key === initialized.current ? widget.show() : widget.hide()));
  }, [loaded, key, data]);

  // O script fica na página depois de carregado uma vez (para conseguir esconder o widget ao sair).
  const [needed, setNeeded] = useState(false);
  if (key && !needed) setNeeded(true);
  if (!needed) return null;
  return <Script src="https://widgets.ifood.com.br/widget.js" strategy="afterInteractive" onReady={() => setLoaded(true)} />;
}
