"use client";

import type { IfoodChatOutboxItem, IfoodChatSyncResult } from "@dishdesk/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { INBOX_CHANGED_EVENT } from "@/hooks/use-inbox-realtime";
import type { WidgetInvite } from "@/lib/ifood-chat-dom";
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
/** O convite de autorização sumiu: espera este tempo antes de o motor voltar a abrir o widget. */
const INVITE_RETRY_MS = 60_000;

let sequence = 0;

const widgetFrame = () => document.querySelector<HTMLIFrameElement>(`iframe[src^="${WIDGET_ORIGIN}"]`)?.contentWindow;

/** Fala com a extensão do Chrome que roda dentro do iframe do widget (apps/extension). */
const bridge: Bridge = (op, params = {}) =>
  new Promise((resolve, reject) => {
    const target = widgetFrame();
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
 * Situação do chat do iFood neste navegador: `off` = o motor não roda (trava desligada, sem loja ou widget ainda fora da
 * tela); `checking` = procurando a extensão ou o widget; `missing` = o widget carregou e a extensão do Chrome não
 * respondeu; `unauthorized`/`authorizing` = a loja não autorizou o widget / está autorizando no Portal do Parceiro;
 * `connected` = as conversas chegam à Inbox. `invite` acompanha `unauthorized` quando o convite traz o link do Portal.
 */
export type IfoodChatStatus = "off" | "checking" | "missing" | "unauthorized" | "authorizing" | "connected";
export type IfoodChatState = { status: IfoodChatStatus; invite: WidgetInvite | null };

// Fica fora do componente: quem roda o motor é o widget (em todas as telas) e quem mostra a situação é a Inbox.
const OFF: IfoodChatState = { status: "off", invite: null };
let state = OFF;
const watchers = new Set<() => void>();
function publish(status: IfoodChatStatus, invite: WidgetInvite | null = null) {
  if (state.status === status && state.invite?.url === invite?.url && state.invite?.skip === invite?.skip) return;
  state = { status, invite };
  for (const watcher of watchers) watcher();
}
function watch(watcher: () => void) {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

export function useIfoodChatState(): IfoodChatState {
  return useSyncExternalStore(
    watch,
    () => state,
    () => OFF,
  );
}

/** O chat do iFood está ligado e o widget carregou, mas a extensão do Chrome não respondeu: nada é copiado por este navegador. */
export function useIfoodExtensionMissing(): boolean {
  return useSyncExternalStore(
    watch,
    () => state.status === "missing",
    () => false,
  );
}

/**
 * Conecta o widget à loja: abre o Portal do Parceiro pelo link do convite (a janela tem de sair do clique no painel; o
 * clique da extensão no widget não abre janelas) e passa o widget para a espera da autorização ("Já tenho o código").
 */
export async function connectIfoodChat(): Promise<void> {
  const { invite } = state;
  if (!invite) return;
  window.open(invite.url, "_blank", "noopener");
  await bridge("click", { selector: "button", index: invite.skip });
}

/**
 * O que o motor do chat faz com o widget: `driving` = opera (o widget fica invisível, aberto na aba Chat);
 * `unauthorized` = abriu o widget e ele pede a autorização da loja; `idle` = não mexe (o widget aparece como sempre).
 */
export type IfoodChatMode = "idle" | "driving" | "unauthorized";

/**
 * Chat do iFood na Inbox (trava IFOOD_CHAT_BRIDGE): com a extensão instalada neste Chrome, copia as conversas do widget
 * e digita nele as respostas escritas na Inbox. Sem a extensão, o widget aparece como sempre e a Inbox avisa para
 * instalar (useIfoodExtensionMissing). Com a loja sem autorizar, o motor espera: volta sozinho quando a autorização termina
 * (ou um minuto depois de o convite sumir, porque a autorização pelo código nem sempre mostra que está em andamento).
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
      // Vezes seguidas em que o widget estava na página e a extensão não respondeu.
      let misses = 0;
      while (!stopped) {
        const loaded = Boolean(widgetFrame());
        const version = await bridge("ping").then((reply) => reply.version, () => undefined);
        if (stopped) return;
        if (!supported(version)) {
          setMode("idle");
          // Uma falha só pode ser o widget ainda carregando: confere de novo logo, e só então avisa que falta a extensão.
          misses = loaded && version === undefined ? misses + 1 : 0;
          if (misses >= 2) publish("missing");
          else if (state.status === "off") publish("checking");
          await sleep(misses === 1 ? STEP_MS : SEARCH_MS);
          continue;
        }
        misses = 0;
        if (state.status === "missing" || state.status === "off") publish("checking");
        if (authorization) {
          // Convite (ou andamento) da autorização na tela: o motor só observa.
          const seen = await driver.authorization().catch(() => authorization);
          if (stopped) return;
          if (seen) {
            authorization = seen;
            setMode(seen === "unauthorized" ? "unauthorized" : "idle");
            publish(seen, driver.seen?.invite);
            await sleep(STEP_MS);
            continue;
          }
          const invite = authorization === "unauthorized";
          authorization = null; // a autorização terminou: o motor segue
          if (invite) {
            // O convite sumiu sem passar por "autorização em andamento" (a autorização pelo código nem sempre mostra): pode
            // ter terminado, ou a loja fechou o convite. O motor volta depois de um tempo, sem reabrir o convite em seguida.
            setMode("idle");
            publish("checking");
            await sleep(INVITE_RETRY_MS);
            continue;
          }
        }
        setMode("driving");
        const take: boolean = claim;
        claim = false;
        try {
          const status = await driver.step(take);
          if (status !== "working") {
            authorization = status;
            claim ||= take;
            if (!stopped) {
              setMode(status === "unauthorized" ? "unauthorized" : "idle");
              publish(status, driver.seen?.invite);
            }
          }
        } catch {
          // Widget recarregando, API fora do ar ou HTML diferente do esperado: o próximo passo tenta de novo.
          claim ||= take;
        }
        // Conectado = o widget abriu com as abas (a loja autorizou), mesmo que a API tenha falhado neste passo.
        if (!stopped && !authorization && driver.seen?.panel) publish("connected");
        await sleep(STEP_MS);
      }
    })();

    return () => {
      stopped = true;
      publish("off");
      window.removeEventListener(INBOX_CHANGED_EVENT, wantClaim);
      clearInterval(fallback);
    };
  }, [enabled]);

  return enabled ? mode : "idle";
}
