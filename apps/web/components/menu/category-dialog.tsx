"use client";

import { useState } from "react";
import { AvailabilityEditor, type AvailabilityDraft } from "@/components/menu/availability-editor";
import { ErrorNote, FIELD_LABEL, TEXTAREA_CLASS, Toggle } from "@/components/menu/bits";
import { useMenuActions } from "@/components/menu/use-menu";
import { useSettingsList } from "@/components/settings/use-settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { HALF_RULES, type MenuCategory, rangesToSlots, slotsToRanges, type StoreDay } from "@/lib/menu";

/**
 * Criar ou editar uma categoria: nome, descrição (sai no cardápio abaixo do nome), se aparece, meio a meio e os horários.
 * `category` null cria. A regra de preço do meio a meio é uma só para todas as categorias (fica em Complementos).
 */
export function CategoryDialog({
  category,
  categories,
  onClose,
  onCreated,
}: {
  category: MenuCategory | null;
  categories: MenuCategory[];
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { call, error, setError, tenantId } = useMenuActions();
  const toast = useToast();
  const settings = useSettingsList();
  const store = (settings.data?.find((entry) => entry.tenantId === tenantId)?.businessHours.days ?? null) as StoreDay[] | null;

  const [name, setName] = useState(category?.name ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [active, setActive] = useState(category?.active ?? true);
  const [allowsHalf, setAllowsHalf] = useState(category?.allowsHalf ?? false);
  const [availability, setAvailability] = useState<AvailabilityDraft>({
    restricted: (category?.availabilities.length ?? 0) > 0,
    ranges: slotsToRanges(category?.availabilities ?? []),
  });
  const [problem, setProblem] = useState<string | null>(null);
  // Categoria criada mas com os horários recusados: o próximo "Salvar" edita ela em vez de criar outra.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const targetId = category?.id ?? createdId;

  // A regra que já vale nas outras categorias com meio a meio; uma categoria nova que liga o meio a meio segue ela.
  const rule = categories.find((other) => other.allowsHalf && other.id !== category?.id)?.halfPricing ?? category?.halfPricing ?? "MAX";
  const ruleName = HALF_RULES.find((entry) => entry.value === rule)?.name ?? "";

  const save = async () => {
    setProblem(null);
    setError(null);
    if (!name.trim()) return setProblem("Dê um nome à categoria.");
    const slots = availability.restricted ? rangesToSlots(availability.ranges) : { slots: [] };
    if ("error" in slots) return setProblem(slots.error);
    const body = { name: name.trim(), description: description.trim(), active, allowsHalf, ...(allowsHalf ? { halfPricing: rule } : {}) };
    const saved = targetId ? await call<MenuCategory>(`/categories/${targetId}`, "PATCH", body) : await call<MenuCategory>("/categories", "POST", body);
    if (!saved) return;
    const id = saved.data.id;
    if (!targetId) {
      setCreatedId(id);
      onCreated?.(id);
    }
    if (!(await call(`/categories/${id}/availability`, "PUT", { slots: slots.slots }))) return;
    toast(category ? "Categoria atualizada" : "Categoria criada");
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[720px] flex-col">
        <div className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="mb-1">{category ? `Editar ${category.name}` : "Nova categoria"}</DialogTitle>
          <DialogDescription>O nome e a descrição aparecem no cardápio. Os horários valem para todos os itens da categoria.</DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cat-name" className={FIELD_LABEL}>
              Nome
            </label>
            <Input id="cat-name" autoFocus maxLength={120} placeholder="Ex.: Pizzas salgadas" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cat-description" className={FIELD_LABEL}>
              Descrição <span className="font-normal text-ink-3">(opcional)</span>
            </label>
            <textarea
              id="cat-description"
              rows={2}
              maxLength={500}
              placeholder="Ex.: Todas com massa de fermentação natural."
              className={TEXTAREA_CLASS}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-col divide-y divide-rule-soft rounded-xl border border-rule">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1">
                <div className="font-medium">Mostrar no cardápio</div>
                <div className="text-xs text-ink-3">Desligada, a categoria e os itens dela somem do cardápio e a IA não oferece.</div>
              </div>
              <Toggle on={active} label="Mostrar a categoria no cardápio" onToggle={() => setActive(!active)} />
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1">
                <div className="font-medium">Meio a meio</div>
                <div className="text-xs text-ink-3">
                  O cliente escolhe dois sabores desta categoria. Regra de preço: {ruleName} (vale para todas as categorias; muda em Complementos).
                </div>
              </div>
              <Toggle on={allowsHalf} label="Permitir meio a meio" onToggle={() => setAllowsHalf(!allowsHalf)} />
            </div>
          </div>
          <AvailabilityEditor subject="category" value={availability} onChange={setAvailability} store={store} />
          {(problem || error) && <ErrorNote>{problem ?? error}</ErrorNote>}
        </div>
        <div className="flex justify-end gap-2 border-t border-rule px-6 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save}>{category ? "Salvar" : "Criar categoria"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
