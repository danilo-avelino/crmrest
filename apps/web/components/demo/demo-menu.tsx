"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";

/** Os roteiros da API (apps/api/src/demo/demo-scripts.ts), na ordem do menu. */
const SCENARIOS = [
  { id: "cade_pedido", label: "Cliente perguntando do pedido", hint: "A IA responde a previsão" },
  { id: "novo_pedido", label: "Pedido pela conversa", hint: "A IA monta o carrinho e confirma" },
  { id: "reclamacao", label: "Reclamação", hint: "A IA chama a equipe e o alarme toca" },
  { id: "duvida", label: "Dúvida de cardápio", hint: "Só a IA atende" },
  { id: "entregador", label: "Entregador chegou", hint: "Menu do entregador avisa o cliente" },
] as const;

/**
 * Menu escondido da conta de demonstração: abre com um toque longo no logo da barra lateral. Simula um cliente
 * escrevendo agora (a conversa chega pela Inbox em tempo real) e volta a demo ao estado inicial. O design não tem esta
 * tela: segue os modais do painel. Desktop no MVP.
 */
export function DemoMenu({ tenantId, open, onOpenChange }: { tenantId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const simulate = async (scenario: string) => {
    setError(null);
    try {
      const { conversationId } = await request<{ conversationId: string }>(`/demo/${tenantId}/simulate`, { method: "POST", body: { scenario } });
      onOpenChange(false);
      toast("Cliente escrevendo agora");
      router.push(`/inbox?conversa=${conversationId}`);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível simular. Tente de novo.");
    }
  };

  const reset = async () => {
    setError(null);
    try {
      await request(`/demo/${tenantId}/reset`, { method: "POST" });
      await queryClient.invalidateQueries();
      onOpenChange(false);
      toast("Demo resetada, com as datas de agora");
      router.push("/inbox");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível resetar a demo. Tente de novo.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="mb-1">Demonstração</DialogTitle>
          <DialogDescription>Nada sai do Dish Desk nesta conta: mensagens, IA e integrações são simuladas.</DialogDescription>
        </div>
        <div className="flex flex-col gap-3 px-6 py-[18px]">
          <p className="text-[13px] font-medium">Simular um cliente escrevendo agora</p>
          <div className="flex flex-col gap-2">
            {SCENARIOS.map((scenario) => (
              <Button key={scenario.id} variant="outline" className="h-auto justify-start py-2 text-left" onClick={() => simulate(scenario.id)}>
                <span className="flex flex-col">
                  <span>{scenario.label}</span>
                  <span className="text-[11px] font-normal text-ink-3">{scenario.hint}</span>
                </span>
              </Button>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-[11.5px] text-tomate">
              {error}
            </p>
          )}
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-rule-soft pt-3">
            <span className="text-[11px] text-ink-3">Volta tudo ao início, com as datas de agora.</span>
            <Button variant="destructive" onClick={reset}>
              Resetar demo
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
