"use client";

import type { IfoodChatOutboxItem, IfoodChatSyncResult } from "@dishdesk/shared";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { INBOX_CHANGED_EVENT } from "@/hooks/use-inbox-realtime";
import { type Bridge, IfoodChatDriver } from "@/lib/ifood-chat-driver";

const WIDGET_ORIGIN = "https://embeddables.ifood.com.br";
const TAG = "ifood-bridge";
/** Primeira versão da extensão que informa a posição dos balões (o lado diz quem enviou a mensagem). */
const MIN_VERSION = [0, 3, 0];
const BRIDGE_TIMEOUT_MS = 4_000;
/** Intervalo entre os passos do motor. */
const STEP_MS = 3_000;
/** Sem a extensão (ou com o widget ainda carregando), procura por ela de novo neste intervalo. */
const SEARCH_MS = 15_000;
/** As respostas da Inbox são buscadas a cada aviso do realtime e, por garantia, neste intervalo. */
const CLAIM_MS = 15_000;

let sequence = 0;

/** Fala com a extensão do Chrome que roda dentro do iframe do widget (apps/extension). */
const bridge: Bridge = (op, params = {}) =>
  new Promise((resolve, reject) => {
    const target = document.querySelector<HTMLIFrameElement>(`iframe[src^="${WIDGET_ORIGIN}"]`)?.contentWindow;
    if (!target) return reject(new Error("O widget do iFood ainda não carregou."));
    const id = ++sequence;
    function onMessage(event: MessageEvent<{ dishdesk?: string; id?: number; ok?: boolean; error?: string; html?: string[]; version?: string }>) {
      if (event.origin !== WIDGET_ORIGIN || event.data?.dishdesk !== TAG || event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error));
    }
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("A extensão do iFood não respondeu."));
    }, BRIDGE_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    target.postMessage({ dishdesk: TAG, id, op, ...params }, WIDGET_ORIGIN);
  });

function supported(version: string | undefined): boolean {
  const parts = (version ?? "").split(".").map(Number);
  for (const [position, minimum] of MIN_VERSION.entries()) {
    const part = parts[position] ?? 0;
    if (part !== minimum) return part > minimum;
  }
  return true;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Chat do iFood na Inbox (trava IFOOD_CHAT_BRIDGE): com a extensão instalada neste Chrome, copia as conversas do widget
 * e digita nele as respostas escritas na Inbox. Devolve true enquanto o motor opera o widget, que então fica invisível
 * (ele precisa ficar aberto na aba Chat). Sem a extensão, ou com a loja sem autorizar, o widget aparece como sempre.
 */
export function useIfoodChat(enabled: boolean): boolean {
  const { request } = useAuth();
  const latestRequest = useRef(request);
  useEffect(() => {
    latestRequest.current = request;
  }, [request]);
  const [driving, setDriving] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let claim = true;
    const wantClaim = () => {
      claim = true;
    };
    window.addEventListener(INBOX_CHANGED_EVENT, wantClaim);
    const fallback = setInterval(wantClaim, CLAIM_MS);
    const post = <T,>(path: string, body?: unknown) => latestRequest.current<T>(`/ifood-chat${path}`, { method: "POST", body });
    const driver = new IfoodChatDriver(bridge, {
      sync: (body) => post<IfoodChatSyncResult>("/sync", body),
      claim: () => post<IfoodChatOutboxItem[]>("/outbox/claim"),
      result: (messageId, body) => post<void>(`/outbox/${messageId}`, body),
    });

    void (async () => {
      while (!stopped) {
        const version = await bridge("ping").then((reply) => reply.version, () => undefined);
        if (stopped) return;
        if (!supported(version)) {
          setDriving(false);
          await sleep(SEARCH_MS);
          continue;
        }
        setDriving(true);
        const take: boolean = claim;
        claim = false;
        try {
          if ((await driver.step(take)) === "unauthorized") {
            if (!stopped) setDriving(false);
            return; // a loja autoriza no Portal do Parceiro; o motor volta quando a página recarregar
          }
        } catch {
          // Widget recarregando, API fora do ar ou HTML diferente do esperado: o próximo passo tenta de novo.
          claim ||= take;
        }
        await sleep(STEP_MS);
      }
    })();

    return () => {
      stopped = true;
      window.removeEventListener(INBOX_CHANGED_EVENT, wantClaim);
      clearInterval(fallback);
    };
  }, [enabled]);

  return enabled && driving;
}
