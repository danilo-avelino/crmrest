"use client";

import { SALES_PITCH_MAX, SALES_RULE_OFFERS_MAX, SALES_RULES_MAX, type SalesRule } from "@dishdesk/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MenuTree } from "@/lib/menu";
import { groupsOfCategory, newSalesRule, offersOf, type SalesOfferRef, type SalesPreset } from "@/lib/menu-agent";
import { cn } from "@/lib/utils";

const SELECT =
  "h-9 min-w-0 rounded-lg border border-input bg-surface px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8 disabled:opacity-55";

const PRESETS: { preset: SalesPreset; label: string }[] = [
  { preset: "drink", label: "Bebida no fim" },
  { preset: "dessert", label: "Sobremesa no fim" },
  { preset: "combo", label: "Combo no hambúrguer" },
];

const ruleId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Venda pela IA (E48): regras por categoria. "Ao pedir" oferece itens ou um complemento dos itens da categoria (combo,
 * borda); "No fim, se faltar" oferece itens da categoria que não está no carrinho. O preço é sempre o do cardápio.
 */
export function SalesRules({ menu, rules, disabled, onChange }: { menu: MenuTree | undefined; rules: SalesRule[]; disabled: boolean; onChange: (rules: SalesRule[]) => void }) {
  if (!menu) return <p className="text-xs text-ink-3">Carregando…</p>;
  if (!menu.categories.length) return <p className="text-xs text-ink-3">Cadastre as categorias do cardápio para criar as regras de venda.</p>;
  const update = (index: number, change: Partial<SalesRule>) => onChange(rules.map((rule, i) => (i === index ? { ...rule, ...change } : rule)));
  const add = (preset: SalesPreset) => onChange([...rules, newSalesRule(menu, preset, ruleId())]);
  const full = rules.length >= SALES_RULES_MAX;

  return (
    <div className={cn("flex flex-col gap-2", disabled && "opacity-55")}>
      {rules.length === 0 && <p className="text-xs text-ink-3">Nenhuma regra. Comece por um atalho abaixo.</p>}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {rules.map((rule, index) => (
          <RuleRow
            key={rule.id}
            index={index}
            rule={rule}
            menu={menu}
            disabled={disabled}
            onChange={(change) => update(index, change)}
            onRemove={() => onChange(rules.filter((_, i) => i !== index))}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" disabled={disabled || full} onClick={() => add("blank")}>
          + Nova regra
        </Button>
        <span className="text-xs text-ink-3">Atalhos:</span>
        {PRESETS.map(({ preset, label }) => (
          <Button key={preset} type="button" variant="ghost" size="sm" disabled={disabled || full} onClick={() => add(preset)}>
            + {label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function RuleRow({
  index,
  rule,
  menu,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  rule: SalesRule;
  menu: MenuTree;
  disabled: boolean;
  onChange: (change: Partial<SalesRule>) => void;
  onRemove: () => void;
}) {
  const groups = rule.trigger === "ON_ADD" ? groupsOfCategory(menu, rule.categoryId) : [];
  const itemName = new Map(menu.categories.flatMap((c) => c.items.map((item) => [item.id, item.soldOut ? `${item.name} (esgotado)` : item.name] as const)));
  const groupName = new Map(menu.optionGroups.map((g) => [g.id, g.name]));
  const offers = offersOf(rule);
  const labelOf = (offer: SalesOfferRef) => (offer.kind === "group" ? `Complemento: ${groupName.get(offer.id) ?? "apagado"}` : (itemName.get(offer.id) ?? "Item apagado"));
  // No fim, os itens são da categoria que falta; ao pedir, qualquer item ativo (refri 2L na pizza).
  const itemCategories = rule.trigger === "AT_END" ? menu.categories.filter((c) => c.id === rule.categoryId) : menu.categories;
  const canAdd = rule.itemIds.length < SALES_RULE_OFFERS_MAX || (groups.length > 0 && rule.groupIds.length < SALES_RULE_OFFERS_MAX);

  function addOffer(value: string) {
    const [kind, id] = value.split(":") as ["item" | "group", string];
    if (!id) return;
    if (kind === "group") onChange({ groupIds: [...rule.groupIds, id] });
    else onChange({ itemIds: [...rule.itemIds, id] });
  }
  function removeOffer(offer: SalesOfferRef) {
    if (offer.kind === "group") onChange({ groupIds: rule.groupIds.filter((id) => id !== offer.id) });
    else onChange({ itemIds: rule.itemIds.filter((id) => id !== offer.id) });
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-rule bg-paper px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink-3 tabular-nums">{index + 1}.</span>
        <select
          aria-label={`Regra ${index + 1}: quando`}
          className={SELECT}
          value={rule.trigger}
          disabled={disabled}
          // Trocar o momento limpa as ofertas: complemento só vale ao pedir, e os itens do fim são da categoria.
          onChange={(event) =>
            onChange({
              trigger: event.target.value as SalesRule["trigger"],
              itemIds: [],
              groupIds: [],
            })
          }
        >
          <option value="ON_ADD">Ao pedir</option>
          <option value="AT_END">No fim, se faltar</option>
        </select>
        <select
          aria-label={`Regra ${index + 1}: categoria`}
          className={cn(SELECT, "flex-1")}
          value={rule.categoryId}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              categoryId: event.target.value,
              itemIds: [],
              groupIds: [],
            })
          }
        >
          {!menu.categories.some((c) => c.id === rule.categoryId) && <option value={rule.categoryId}>Categoria apagada</option>}
          {menu.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onRemove} aria-label={`Remover regra ${index + 1}`}>
          Remover
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-ink-3">Oferecer:</span>
        {offers.map((offer) => (
          <span key={`${offer.kind}:${offer.id}`} className="inline-flex h-7 items-center gap-1 rounded-full border border-rule bg-surface pr-1 pl-2.5 text-xs">
            {labelOf(offer)}
            <button
              type="button"
              disabled={disabled}
              onClick={() => removeOffer(offer)}
              aria-label={`Tirar ${labelOf(offer)}`}
              className="flex size-5 items-center justify-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              ×
            </button>
          </span>
        ))}
        {rule.trigger === "AT_END" && offers.length === 0 && <span className="text-xs text-ink-2">os mais vendidos da categoria</span>}
        {canAdd && (
          <select aria-label={`Regra ${index + 1}: adicionar oferta`} className={cn(SELECT, "h-7 text-xs")} value="" disabled={disabled} onChange={(event) => addOffer(event.target.value)}>
            <option value="">+ Adicionar</option>
            {groups.length > 0 && rule.groupIds.length < SALES_RULE_OFFERS_MAX && (
              <optgroup label="Complementos dos itens (combo, borda...)">
                {groups
                  .filter((group) => !rule.groupIds.includes(group.id))
                  .map((group) => (
                    <option key={group.id} value={`group:${group.id}`}>
                      {group.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {rule.itemIds.length < SALES_RULE_OFFERS_MAX &&
              itemCategories.map((category) => (
                <optgroup key={category.id} label={category.name}>
                  {category.items
                    .filter((item) => item.active && !rule.itemIds.includes(item.id))
                    .map((item) => (
                      <option key={item.id} value={`item:${item.id}`}>
                        {itemName.get(item.id)}
                      </option>
                    ))}
                </optgroup>
              ))}
          </select>
        )}
      </div>
      {rule.trigger === "ON_ADD" && groups.length === 0 && rule.itemIds.length === 0 && (
        <p className="m-0 text-xs text-warning-ink">
          Os itens desta categoria não têm complementos. Para oferecer combo, crie o grupo (ex.: &quot;Transformar em combo&quot;) em Cardápio → Complementos e ligue aos itens.
        </p>
      )}
      <Input
        aria-label={`Regra ${index + 1}: argumento`}
        className="h-8 text-xs"
        maxLength={SALES_PITCH_MAX}
        disabled={disabled}
        placeholder='Argumento (opcional), ex.: "refri e batata juntos saem mais em conta"'
        value={rule.pitch}
        onChange={(event) => onChange({ pitch: event.target.value })}
      />
    </li>
  );
}
