import { describe, expect, it } from "vitest";
import { contrastWithWhite, menuThemeStyle, paletteFromPixels, readableOnWhite } from "./menu-theme";

/** Pixels RGBA: cada cor repetida `count` vezes. */
function pixels(...colors: [number, number, number, number, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [r, g, b, a, count] of colors) for (let i = 0; i < count; i++) out.push(r, g, b, a);
  return new Uint8ClampedArray(out);
}

describe("cores do cardápio a partir da logo", () => {
  it("pega as cores mais frequentes, ignora branco, preto, cinza e transparência", () => {
    const colors = paletteFromPixels(
      pixels([255, 255, 255, 255, 500], [0, 0, 0, 255, 300], [128, 128, 128, 255, 200], [255, 0, 0, 0, 400], [200, 30, 30, 255, 100], [20, 60, 180, 255, 50], [20, 140, 60, 255, 20]),
    );
    expect(colors).toHaveLength(3);
    // Ordem de frequência: vermelho, azul, verde.
    expect(colors[0]).toBe(readableOnWhite("#C81E1E"));
    expect(colors[1]).toBe(readableOnWhite("#143CB4"));
    expect(colors[2]).toBe(readableOnWhite("#148C3C"));
  });

  it("toda sugestão deixa o texto branco legível", () => {
    const colors = paletteFromPixels(pixels([255, 220, 0, 255, 100], [120, 220, 255, 255, 80]));
    for (const color of colors) expect(contrastWithWhite(color)).toBeGreaterThanOrEqual(4.5);
  });

  it("logo de uma cor só: as outras opções são tons mais escuros; sem cor nenhuma, vazio", () => {
    const colors = paletteFromPixels(pixels([200, 30, 30, 255, 100]));
    expect(colors).toHaveLength(3);
    expect(new Set(colors).size).toBe(3);
    expect(paletteFromPixels(pixels([255, 255, 255, 255, 50], [10, 10, 10, 255, 50]))).toEqual([]);
  });
});

describe("tema do cardápio público", () => {
  it("só a cor de destaque com o tema desligado; fundo e bordas tingidos com ele ligado", () => {
    expect(menuThemeStyle({ accentColor: "#B4341A", brandTheme: false })).toEqual({ "--menu-accent": "#B4341A" });
    const style = menuThemeStyle({ accentColor: "#B4341A", brandTheme: true }) as Record<string, string>;
    expect(style["--menu-accent"]).toBe("#B4341A");
    expect(style["--color-paper"]).toMatch(/^#[0-9A-F]{6}$/);
    expect(style.backgroundColor).toBe(style["--color-paper"]);
    expect(style["--color-rule"]).not.toBe(style["--color-paper"]);
  });
});
