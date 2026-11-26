"use client";

import { ChevronDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { IfoodImportRequestDialog, useImportRequests } from "@/components/menu/ifood-import-request";
import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Ações do topo do Cardápio no número do board P1 (Ver cardápio público · Importar · Novo item): o "Importar" abre a
 * planilha ou a foto/PDF e o pedido de importação do iFood. Funil, abandonados e complementos ficam na faixa lateral do Cardápio.
 */
export function MenuHeaderMenus() {
  const router = useRouter();
  const [ifood, setIfood] = useState(false);
  const requests = useImportRequests();
  const pending = requests.data?.some((r) => r.status === "OPEN");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(buttonVariants({ variant: "outline" }), "gap-1")}>
          Importar <ChevronDownIcon className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuItem onClick={() => router.push("/cardapio/importar")}>Planilha (CSV) ou foto/PDF</DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onClick={() => setIfood(true)}>
            {pending ? "Do iFood · pedido aguardando a equipe" : "Do iFood (a equipe importa)"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IfoodImportRequestDialog open={ifood} onOpenChange={setIfood} />
    </>
  );
}
