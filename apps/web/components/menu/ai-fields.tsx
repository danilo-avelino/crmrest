"use client";

import { type Dispatch, type SetStateAction, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Campos da aba "Para a IA" que a IA pode preencher (F2-15). */
export type AiFieldKey = "ingredients" | "synonyms" | "tags" | "allergens" | "servesPeople" | "aiNotes" | "pairIds";

export type AiFillable = {
  ingredients: string[];
  synonyms: string[];
  tags: string[];
  allergens: string[];
  servesPeople: string;
  aiNotes: string;
  pairIds: string[];
};

/** Resposta de `POST /menu/:tenantId/items/ai-fields`. */
export type AiFieldsResponse = {
  ingredients: string[];
  synonyms: string[];
  tags: string[];
  allergens: string[];
  servesPeople: number | null;
  aiNotes: string | null;
  pairsWith: string[];
};

/**
 * O que a IA preenche: só os campos que estão vazios, nunca o que o usuário já escreveu. "Combina com" só aceita itens
 * que existem no cardápio carregado. `filled` diz quais campos receberam sugestão.
 */
export function applyAiFields(draft: AiFillable, result: AiFieldsResponse, knownIds: ReadonlySet<string>): { patch: Partial<AiFillable>; filled: AiFieldKey[] } {
  const patch: Partial<AiFillable> = {};
  const filled: AiFieldKey[] = [];
  const put = <K extends AiFieldKey>(key: K, current: AiFillable[K], next: AiFillable[K]) => {
    const empty = Array.isArray(current) ? current.length === 0 : current.trim() === "";
    const has = Array.isArray(next) ? next.length > 0 : next.trim() !== "";
    if (!empty || !has) return;
    patch[key] = next;
    filled.push(key);
  };
  put("ingredients", draft.ingredients, result.ingredients);
  put("synonyms", draft.synonyms, result.synonyms);
  put("tags", draft.tags, result.tags);
  put("allergens", draft.allergens, result.allergens);
  put("servesPeople", draft.servesPeople, result.servesPeople === null ? "" : String(result.servesPeople));
  put("aiNotes", draft.aiNotes, result.aiNotes ?? "");
  put(
    "pairIds",
    draft.pairIds,
    result.pairsWith.filter((id) => knownIds.has(id)),
  );
  return { patch, filled };
}

type FillDraft = AiFillable & { name: string; categoryId: string; description: string; priceText: string; sizes: { name: string; priceText: string }[] };

/**
 * "Preencher com IA": estado da marca "sugerido pela IA" e dos alérgenos ainda não confirmados. A marca de um campo some
 * quando o usuário o edita (`clearMark`). Os alérgenos sugeridos só valem depois de confirmados chip a chip ou de uma vez.
 */
export function useAiFill<D extends FillDraft>({
  draft,
  setDraft,
  itemId,
  categoryName,
  knownIds,
  parsePrice,
}: {
  draft: D;
  setDraft: Dispatch<SetStateAction<D>>;
  itemId?: string;
  categoryName?: string;
  knownIds: ReadonlySet<string>;
  parsePrice: (text: string) => number | null;
}) {
  const { request } = useAuth();
  const tenantId = useTenantId();
  const [marks, setMarks] = useState<AiFieldKey[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const name = draft.name.trim();

  async function fill() {
    setError(null);
    setNotice(null);
    try {
      const sizes = draft.sizes.filter((size) => size.name.trim()).map((size) => ({ name: size.name.trim(), priceCents: parsePrice(size.priceText) ?? undefined }));
      const priceCents = parsePrice(draft.priceText);
      const result = await request<AiFieldsResponse>(`/menu/${tenantId}/items/ai-fields`, {
        method: "POST",
        body: {
          name,
          ...(categoryName && { categoryName }),
          ...(draft.description.trim() && { description: draft.description.trim() }),
          ...(sizes.length > 0 && { sizes }),
          ...(priceCents !== null && { priceCents }),
          ...(itemId && { itemId }),
        },
      });
      const { patch, filled } = applyAiFields(draft, result, knownIds);
      if (filled.length === 0) {
        setNotice("Nada para preencher: os campos já têm conteúdo ou a IA não achou o que sugerir.");
        return;
      }
      setDraft((current) => ({ ...current, ...patch }));
      setMarks((current) => [...new Set([...current, ...filled])]);
      if (patch.allergens) setPending(patch.allergens);
      setNotice(`${filled.length} ${filled.length === 1 ? "campo preenchido" : "campos preenchidos"} pela IA. Revise e edite à vontade.`);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível preencher com a IA. Tente de novo.");
    }
  }

  /** Alérgeno tocado: confirmado (se estava pendente). Sem pendência, a marca do campo também some. */
  function confirmAllergen(allergen: string) {
    setPending((current) => {
      const next = current.filter((other) => other !== allergen);
      if (next.length === 0) setMarks((list) => list.filter((key) => key !== "allergens"));
      return next;
    });
  }

  return {
    marks,
    pending,
    error,
    notice,
    fill,
    canFill: name !== "" && Boolean(tenantId),
    nameMissing: name === "",
    clearMark: (key: AiFieldKey) => setMarks((current) => (current.includes(key) ? current.filter((other) => other !== key) : current)),
    confirmAllergen,
    confirmAllAllergens: () => {
      setPending([]);
      setMarks((current) => current.filter((key) => key !== "allergens"));
    },
  };
}

/** Marca discreta ao lado do rótulo do campo preenchido pela IA. */
export function AiMark() {
  return <span className="ml-1 inline-flex h-[18px] items-center rounded-sm bg-tomate-lt px-1.5 text-[10.5px] font-medium text-tomate-ink">sugerido pela IA</span>;
}

/** Aviso colado nos alérgenos sugeridos: some quando todos foram confirmados. */
export function AllergenWarning({ pending, onConfirmAll }: { pending: string[]; onConfirmAll: () => void }) {
  if (pending.length === 0) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-warning-lt px-2.5 py-2 text-[12.5px] text-warning-ink">
      <span className="min-w-0 flex-1 basis-40">Confira os alérgenos: a IA pode errar</span>
      <Button type="button" size="xs" variant="outline" onClick={onConfirmAll}>
        Confirmar alérgenos
      </Button>
    </div>
  );
}

/** Chip de alérgeno: um chip sugerido pela IA e ainda não confirmado fica âmbar com "confirme". */
export function AllergenChip({ name, on, unconfirmed, onToggle }: { name: string; on: boolean; unconfirmed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "h-7 rounded-lg border px-2.5 text-[12.5px] font-medium",
        unconfirmed ? "border-warning bg-warning-lt text-warning-ink" : on ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2",
      )}
    >
      {name}
      {unconfirmed && <span className="ml-1 text-[10.5px] font-semibold">confirme</span>}
    </button>
  );
}
