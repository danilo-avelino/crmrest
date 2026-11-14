"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

/** Enquanto o som está bloqueado (ninguém clicou na página), o chamado volta a notificar neste intervalo. */
const REPEAT_MS = 2 * 60_000;

type Permission = NotificationPermission | "unsupported";

const listeners = new Set<() => void>();
const readPermission = (): Permission => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

/** Permissão de notificação deste navegador (vale para o site, inclusive depois de reabrir o Chrome). */
export function useNotificationPermission(): Permission {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readPermission,
    () => "unsupported",
  );
}

/** Pede a permissão; o Chrome só mostra o pedido a partir de um clique. */
export async function askNotificationPermission() {
  if (typeof Notification === "undefined") return;
  await Notification.requestPermission();
  for (const listener of listeners) listener();
}

// Fora do componente: trocar de página (Inbox ↔ Configurações) não notifica de novo o mesmo chamado.
let last = { calling: 0, quiet: 0 };
let callingNote: Notification | null = null;
let quietNote: Notification | null = null;

const plural = (count: number, verb: string) => (count === 1 ? `1 conversa ${verb} um atendente` : `${count} conversas ${verb} um atendente`);

function show(title: string, body: string, tag: string, urgent: boolean, onOpen: () => void): Notification | null {
  if (readPermission() !== "granted") return null;
  try {
    // `renotify` faz o Windows tocar o som de novo ao trocar a notificação de mesma tag (fora dos tipos do TS).
    const options: NotificationOptions & { renotify: boolean } = { body, tag, icon: "/icon.svg", requireInteraction: urgent, renotify: true };
    const note = new Notification(title, options);
    note.onclick = () => {
      window.focus();
      note.close();
      onOpen();
    };
    return note;
  } catch {
    return null;
  }
}

/**
 * Notificação do sistema para os chamados. Com a aba aberta pelo Chrome sem ninguém clicar nela, o navegador não
 * deixa a página tocar som; a notificação do Windows toca o próprio. Notifica quando aumentam os chamados e, com o som
 * da página bloqueado, repete o urgente a cada 2 minutos. `counts` é null enquanto os números não chegaram.
 */
export function useCallNotifications(counts: { calling: number; quiet: number } | null, blocked: boolean) {
  const router = useRouter();
  const calling = counts?.calling ?? 0;
  const quiet = counts?.quiet ?? 0;
  const loaded = counts !== null;

  useEffect(() => {
    if (!loaded) return;
    const before = last;
    last = { calling, quiet };
    const open = () => router.push("/inbox");
    if (calling > before.calling) callingNote = show("Chamando atendente", plural(calling, "chamando"), "dd-calling", true, open) ?? callingNote;
    if (quiet > before.quiet) quietNote = show("Aguardando atendente", plural(quiet, "aguardando"), "dd-quiet", false, open) ?? quietNote;
    if (calling === 0) {
      callingNote?.close();
      callingNote = null;
    }
    if (quiet === 0) {
      quietNote?.close();
      quietNote = null;
    }
  }, [loaded, calling, quiet, router]);

  useEffect(() => {
    if (!blocked || calling === 0) return;
    const timer = setInterval(() => {
      callingNote = show("Chamando atendente", plural(calling, "chamando"), "dd-calling", true, () => router.push("/inbox")) ?? callingNote;
    }, REPEAT_MS);
    return () => clearInterval(timer);
  }, [blocked, calling, router]);
}
