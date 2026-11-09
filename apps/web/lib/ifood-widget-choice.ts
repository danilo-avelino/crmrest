import { useSyncExternalStore } from "react";

/**
 * Se este computador usa o widget do iFood. O widget só carrega depois do "Sim": no computador que não atende (ex.: o da
 * administração), o pedido de autorização do iFood não aparece. `on`/`off` ficam guardados no navegador; `later` = "Não"
 * sem "não perguntar de novo", que vale até fechar a aba; `ask` = ainda não respondeu.
 */
export type IfoodWidgetChoice = "ask" | "on" | "off" | "later";

const KEY = "dd_ifood_widget";
const watchers = new Set<() => void>();

function read(): IfoodWidgetChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "on" || saved === "off") return saved;
    return sessionStorage.getItem(KEY) === "later" ? "later" : "ask";
  } catch {
    return "ask";
  }
}

export function setIfoodWidgetChoice(choice: Exclude<IfoodWidgetChoice, "ask">): void {
  try {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    if (choice === "later") sessionStorage.setItem(KEY, "later");
    else localStorage.setItem(KEY, choice);
  } catch {
    // Sem armazenamento (janela anônima bloqueada): a escolha vale só nesta página.
    fallback = choice;
  }
  for (const watcher of watchers) watcher();
}

let fallback: IfoodWidgetChoice | null = null;

export function useIfoodWidgetChoice(): IfoodWidgetChoice {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    () => fallback ?? read(),
    () => "ask",
  );
}
