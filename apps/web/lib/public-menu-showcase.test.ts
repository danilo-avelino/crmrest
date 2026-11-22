import { describe, expect, it } from "vitest";
import { type PublicMenuCategory, showcaseDue, showcaseItems } from "./public-menu";

const item = (id: string, patch: object = {}) => ({
  id,
  categoryId: "c1",
  name: id,
  description: null,
  priceCents: 1000,
  photoUrl: null,
  soldOut: false,
  availableNow: true,
  allowsHalf: false,
  sizes: [],
  optionGroups: [],
  tags: [],
  ingredients: [],
  allergens: [],
  servesPeople: null,
  ...patch,
});

const categories = [{ id: "c1", name: "Pizzas", items: [item("a"), item("b", { soldOut: true }), item("c", { availableNow: false }), item("d")] }] as unknown as PublicMenuCategory[];

describe("vitrine de promoções (W3, R4)", () => {
  it("segue a ordem da loja e nunca mostra esgotado, fora do horário ou item que não existe", () => {
    expect(showcaseItems(categories, ["d", "b", "x", "c", "a"]).map((i) => i.id)).toEqual(["d", "a"]);
  });

  it("aparece de novo só depois do período", () => {
    const hour = 3_600_000;
    expect(showcaseDue(null, 0, 24)).toBe(true);
    expect(showcaseDue(0, 23 * hour, 24)).toBe(false);
    expect(showcaseDue(0, 24 * hour, 24)).toBe(true);
    expect(showcaseDue(Number.NaN, 0, 24)).toBe(true);
  });
});
