"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { useIfoodWidget } from "@/components/ifood-widget";
import { Button } from "@/components/ui/button";
import { useIfoodExtensionMissing } from "@/hooks/use-ifood-chat";

/**
 * Faixa no topo da Inbox quando o chat do iFood está ligado e este navegador não tem a extensão do Chrome
 * (apps/extension): sem ela, as conversas do iFood não são copiadas por este computador. "Instalar" abre a página da
 * extensão na Chrome Web Store (sem o endereço na API, a faixa sai sem o botão). A extensão só entra no widget quando a
 * página carrega, por isso o "Recarregar" depois de instalar. O design não tem este aviso: segue o alerta âmbar do
 * board Clientes. Desktop no MVP.
 */
export function IfoodExtensionAlert() {
  const missing = useIfoodExtensionMissing();
  const storeUrl = useIfoodWidget().data?.extensionUrl;
  // A página da extensão já foi aberta por aqui: falta recarregar o painel.
  const [opened, setOpened] = useState(false);
  if (!missing) return null;

  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-warning-line bg-warning-lt px-4 py-2 text-xs text-warning-ink">
      <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span>
        {opened ? (
          "Depois de instalar a extensão, recarregue a página para as conversas do iFood chegarem à Inbox."
        ) : (
          <>
            As conversas do iFood não chegam à Inbox por este computador: falta a{" "}
            <strong className="font-medium">extensão do Dish Desk no Chrome</strong>.
          </>
        )}
      </span>
      {storeUrl && (
        <Button
          size="xs"
          variant={opened ? "outline" : "default"}
          onClick={() => {
            window.open(storeUrl, "_blank", "noopener");
            setOpened(true);
            // Segura o botão por um instante: um duplo clique abriria a loja duas vezes.
            return new Promise((resolve) => setTimeout(resolve, 1_000));
          }}
        >
          Instalar
        </Button>
      )}
      {opened && (
        <Button
          size="xs"
          onClick={() => {
            window.location.reload();
            return new Promise(() => {}); // "Carregando…" até a página recarregar
          }}
        >
          Recarregar
        </Button>
      )}
    </div>
  );
}
