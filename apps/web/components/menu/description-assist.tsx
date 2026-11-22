"use client";

import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";

/** O que o formulário do item entrega para a sugestão (F2-15); serve para item novo, ainda não salvo. */
export type DescribeInput = { name: string; categoryName?: string; description: string; ingredients: string[]; tags: string[]; servesPeople: string };

/**
 * "Melhorar com IA" na descrição do item: pede a sugestão ao servidor e a guarda até o administrador escolher.
 * Nunca mexe na descrição sozinho: quem aplica é o `onUse` da caixa da sugestão.
 */
export function useDescribeAssist(input: DescribeInput) {
  const { request } = useAuth();
  const tenantId = useTenantId();
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = input.name.trim();

  async function improve() {
    setError(null);
    try {
      const body = {
        name,
        ...(input.categoryName && { categoryName: input.categoryName }),
        ...(input.description.trim() && { description: input.description.trim() }),
        ...(input.ingredients.length > 0 && { ingredients: input.ingredients }),
        ...(input.tags.length > 0 && { tags: input.tags }),
        ...(Number(input.servesPeople) >= 1 && { servesPeople: Number(input.servesPeople) }),
      };
      const result = await request<{ suggestion: string }>(`/menu/${tenantId}/items/describe`, { method: "POST", body });
      setSuggestion(result.suggestion);
    } catch (failure) {
      setSuggestion(null);
      setError(failure instanceof ApiError ? failure.message : "Não foi possível gerar a sugestão. Tente de novo.");
    }
  }

  return { suggestion, error, improve, discard: () => setSuggestion(null), canImprove: name !== "" && Boolean(tenantId), nameMissing: name === "" };
}

/** Botão pequeno ao lado do contador da descrição. O clique assíncrono já tem guard de duplo clique e "Carregando…". */
export function DescribeButton({ onImprove, disabled, nameMissing }: { onImprove: () => Promise<void>; disabled: boolean; nameMissing: boolean }) {
  return (
    <span title={nameMissing ? "Preencha o nome" : undefined}>
      <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onImprove}>
        <SparklesIcon className="text-tomate" aria-hidden />
        Melhorar com IA
      </Button>
    </span>
  );
}

/** A sugestão sob o campo: Usar troca a descrição (o item só muda ao salvar) e Descartar fecha a caixa. */
export function SuggestionBox({ suggestion, onUse, onDiscard }: { suggestion: string; onUse: (text: string) => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-rule bg-surface-2 px-3 py-2.5" data-testid="description-suggestion">
      <div className="text-[11.5px] font-medium text-ink-3">Sugestão da IA</div>
      <p className="whitespace-pre-wrap text-ink">{suggestion}</p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => onUse(suggestion)}>
          Usar
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDiscard}>
          Descartar
        </Button>
      </div>
    </div>
  );
}
