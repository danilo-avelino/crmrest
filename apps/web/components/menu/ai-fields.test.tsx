import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AiFieldsResponse, type AiFillable, AllergenChip, AllergenWarning, applyAiFields, useAiFill } from "./ai-fields";
import { DescribeButton, SuggestionBox } from "./description-assist";

const request = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request }) }));
vi.mock("@/components/menu/use-menu", () => ({ useTenantId: () => "t1" }));

afterEach(() => {
  cleanup();
  request.mockReset();
});

const empty: AiFillable = { ingredients: [], synonyms: [], tags: [], allergens: [], servesPeople: "", aiNotes: "", pairIds: [] };
const result: AiFieldsResponse = {
  ingredients: ["calabresa"],
  synonyms: ["calab"],
  tags: ["picante"],
  allergens: ["Glúten"],
  servesPeople: 2,
  aiNotes: "Sugerir borda.",
  pairsWith: ["i1", "de-fora"],
};

describe("applyAiFields (F2-15)", () => {
  it("preenche todos os campos vazios e só aceita combina com de item conhecido", () => {
    const { patch, filled } = applyAiFields(empty, result, new Set(["i1"]));
    expect(patch).toEqual({ ingredients: ["calabresa"], synonyms: ["calab"], tags: ["picante"], allergens: ["Glúten"], servesPeople: "2", aiNotes: "Sugerir borda.", pairIds: ["i1"] });
    expect(filled).toHaveLength(7);
  });

  it("nunca sobrescreve o que o usuário já preencheu", () => {
    const draft = { ...empty, ingredients: ["queijo"], servesPeople: "4", aiNotes: "minha nota" };
    const { patch, filled } = applyAiFields(draft, result, new Set(["i1"]));
    expect(patch).not.toHaveProperty("ingredients");
    expect(patch).not.toHaveProperty("servesPeople");
    expect(patch).not.toHaveProperty("aiNotes");
    expect(filled).toEqual(["synonyms", "tags", "allergens", "pairIds"]);
  });

  it("sugestão vazia não marca campo", () => {
    expect(applyAiFields(empty, { ...result, servesPeople: null, aiNotes: null, pairsWith: [] }, new Set()).filled).toEqual(["ingredients", "synonyms", "tags", "allergens"]);
  });
});

describe("useAiFill (F2-15)", () => {
  const draft = { ...empty, name: "Calabresa", categoryId: "c1", description: "", priceText: "30,00", sizes: [] };
  const setup = (start = draft) =>
    renderHook(() => {
      const [current, setCurrent] = useState(start);
      return { current, ai: useAiFill({ draft: current, setDraft: setCurrent, categoryName: "Pizzas", knownIds: new Set(["i1"]), parsePrice: (text) => (text ? 3000 : null) }) };
    });

  it("preenche só os vazios, marca os campos e a marca some ao editar", async () => {
    request.mockResolvedValue(result);
    const { result: hook } = setup({ ...draft, ingredients: ["queijo"] });
    await act(() => hook.current.ai.fill());
    expect(request).toHaveBeenCalledWith("/menu/t1/items/ai-fields", { method: "POST", body: { name: "Calabresa", categoryName: "Pizzas", priceCents: 3000 } });
    expect(hook.current.current.ingredients).toEqual(["queijo"]);
    expect(hook.current.current.synonyms).toEqual(["calab"]);
    expect(hook.current.ai.marks).toEqual(["synonyms", "tags", "allergens", "servesPeople", "aiNotes", "pairIds"]);
    act(() => hook.current.ai.clearMark("synonyms"));
    expect(hook.current.ai.marks).not.toContain("synonyms");
    expect(hook.current.ai.marks).toContain("tags");
  });

  it("alérgenos sugeridos ficam pendentes até tocar em cada chip ou confirmar todos", async () => {
    request.mockResolvedValue({ ...result, allergens: ["Glúten", "Leite"] });
    const { result: hook } = setup();
    await act(() => hook.current.ai.fill());
    expect(hook.current.ai.pending).toEqual(["Glúten", "Leite"]);
    act(() => hook.current.ai.confirmAllergen("Glúten"));
    expect(hook.current.ai.pending).toEqual(["Leite"]);
    act(() => hook.current.ai.confirmAllAllergens());
    expect(hook.current.ai.pending).toEqual([]);
    expect(hook.current.ai.marks).not.toContain("allergens");
  });

  it("erro da API aparece e nada muda", async () => {
    const { ApiError } = await import("@/lib/api");
    request.mockRejectedValue(new ApiError(429, "Limite de 200 sugestões por dia atingido. Tente amanhã."));
    const { result: hook } = setup();
    await act(() => hook.current.ai.fill());
    expect(hook.current.ai.error).toBe("Limite de 200 sugestões por dia atingido. Tente amanhã.");
    expect(hook.current.ai.marks).toEqual([]);
    expect(hook.current.current.ingredients).toEqual([]);
  });
});

describe("alérgenos sugeridos (F2-15)", () => {
  it("chip pendente mostra confirme e o aviso some quando não há pendência", () => {
    const onConfirmAll = vi.fn();
    const { rerender } = render(
      <>
        <AllergenWarning pending={["Glúten"]} onConfirmAll={onConfirmAll} />
        <AllergenChip name="Glúten" on unconfirmed onToggle={() => {}} />
      </>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Confira os alérgenos: a IA pode errar");
    expect(screen.getByRole("button", { name: /Glúten/ }).textContent).toContain("confirme");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar alérgenos" }));
    expect(onConfirmAll).toHaveBeenCalledOnce();
    rerender(
      <>
        <AllergenWarning pending={[]} onConfirmAll={onConfirmAll} />
        <AllergenChip name="Glúten" on unconfirmed={false} onToggle={() => {}} />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Glúten" }).textContent).not.toContain("confirme");
  });
});

describe("caixa da sugestão da descrição (F2-15)", () => {
  it("Usar entrega o texto e Descartar não entrega nada", () => {
    const onUse = vi.fn();
    const onDiscard = vi.fn();
    render(<SuggestionBox suggestion="Pizza de calabresa com cebola." onUse={onUse} onDiscard={onDiscard} />);
    expect(screen.getByText("Pizza de calabresa com cebola.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Usar" }));
    expect(onUse).toHaveBeenCalledWith("Pizza de calabresa com cebola.");
  });

  it("botão fica desabilitado sem nome, com a dica Preencha o nome", () => {
    render(<DescribeButton onImprove={async () => {}} disabled nameMissing />);
    expect(screen.getByRole("button", { name: /Melhorar com IA/ }).hasAttribute("disabled") || screen.getByRole("button", { name: /Melhorar com IA/ }).getAttribute("data-disabled") !== null).toBe(true);
    expect(screen.getByTitle("Preencha o nome")).toBeTruthy();
  });
});
