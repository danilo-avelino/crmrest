"use client";

import type { IfoodChatOutboxItem, IfoodChatSyncResult } from "@dishdesk/shared";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { INBOX_CHANGED_EVENT } from "@/hooks/use-inbox-realtime";
import { type Bridge, type DriverStatus, IfoodChatDriver } from "@/lib/ifood-chat-driver";

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
 * O que o motor do chat faz com o widget: `driving` = opera (o widget fica invisível, aberto na aba Chat);
 * `unauthorized` = abriu o widget e ele pede a autorização da loja; `idle` = não mexe (o widget aparece como sempre).
 */
export type IfoodChatMode = "idle" | "driving" | "unauthorized";

/**
 * Chat do iFood na Inbox (trava IFOOD_CHAT_BRIDGE): com a extensão instalada neste Chrome, copia as conversas do widget
 * e digita nele as respostas escritas na Inbox. Sem a extensão, o widget aparece como sempre. Com a loja sem autorizar,
 * o motor espera: volta sozinho quando a autorização termina.
 */
export function useIfoodChat(enabled: boolean): IfoodChatMode {
  const { request } = useAuth();
  const latestRequest = useRef(request);
  useEffect(() => {
    latestRequest.current = request;
  }, [request]);
  const [mode, setMode] = useState<IfoodChatMode>("idle");

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
      // O que o widget mostrou sobre a autorização da loja; null = nada, o motor opera.
      let authorization: Exclude<DriverStatus, "working"> | null = null;
      while (!stopped) {
        const version = await bridge("ping").then((reply) => reply.version, () => undefined);
        if (stopped) return;
        if (!supported(version)) {
          setMode("idle");
          await sleep(SEARCH_MS);
          continue;
        }
        if (authorization) {
          // Convite (ou andamento) da autorização na tela: o motor só observa.
          const seen = await driver.authorization().catch(() => authorization);
          if (stopped) return;
          if (seen) {
            authorization = seen;
            setMode(seen === "unauthorized" ? "unauthorized" : "idle");
            await sleep(STEP_MS);
            continue;
          }
          if (authorization === "unauthorized") {
            setMode("idle");
            return; // a loja fechou o convite sem autorizar: o motor volta quando a página recarregar
          }
          authorization = null; // a autorização terminou: o motor segue
        }
        setMode("driving");
        const take: boolean = claim;
        claim = false;
        try {
          const status = await driver.step(take);
          if (status !== "working") {
            authorization = status;
            claim ||= take;
            if (!stopped) setMode(status === "unauthorized" ? "unauthorized" : "idle");
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

  return enabled ? mode : "idle";
}
