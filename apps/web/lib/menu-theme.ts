import type { CSSProperties } from "react";

// Cores do cardápio público: a cor de destaque do restaurante e, com o tema completo, o fundo, as faixas e as bordas
// tingidos com ela. As 3 sugestões da tela Configurações → Cardápio saem das cores da logo. Sem React, para testar sozinho.

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const rgbToHex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** `amount` de 0 (a cor) a 1 (branco). */
const towardWhite = (rgb: Rgb, amount: number): Rgb => rgb.map((c) => c + (255 - c) * amount) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contraste WCAG entre a cor e o branco (1 a 21). */
export const contrastWithWhite = (hex: string) => 1.05 / (luminance(hexToRgb(hex)) + 0.05);

/** Escurece a cor até o texto branco dos botões ficar legível (contraste ≥ 4,5). */
export function readableOnWhite(hex: string): string {
  let rgb = hexToRgb(hex);
  while (contrastWithWhite(rgbToHex(rgb)) < 4.5) rgb = rgb.map((c) => c * 0.92) as Rgb;
  return rgbToHex(rgb);
}

/**
 * Variáveis CSS do cardápio público: `--menu-accent` sempre; com o tema completo, os tons claros do tema (papel, faixa e
 * bordas) passam a ser a cor de destaque misturada com branco. Cartões e textos continuam brancos e escuros.
 */
export function menuThemeStyle(store: { accentColor: string; brandTheme: boolean }): CSSProperties {
  const style: Record<string, string> = { "--menu-accent": store.accentColor };
  if (store.brandTheme && /^#[0-9a-fA-F]{6}$/.test(store.accentColor)) {
    const rgb = hexToRgb(store.accentColor);
    style["--color-paper"] = rgbToHex(towardWhite(rgb, 0.93));
    // O fundo do layout (/c) fica fora deste elemento: pinta aqui também.
    style.backgroundColor = style["--color-paper"];
    style["--color-surface-2"] = rgbToHex(towardWhite(rgb, 0.88));
    style["--color-rule-soft"] = rgbToHex(towardWhite(rgb, 0.84));
    style["--color-rule"] = rgbToHex(towardWhite(rgb, 0.76));
  }
  return style as CSSProperties;
}

const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Até 3 cores para o cardápio a partir dos pixels RGBA da logo: as mais frequentes que têm cor (sem branco, preto e
 * cinza nem transparência), distintas entre si e escurecidas até o texto branco ficar legível. Com uma cor só, as outras
 * opções são tons mais escuros dela; logo sem cor nenhuma devolve vazio.
 */
export function paletteFromPixels(pixels: Uint8ClampedArray): string[] {
  const buckets = new Map<number, { count: number; sum: Rgb }>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const rgb: Rgb = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    if (pixels[i + 3]! < 200) continue;
    const max = Math.max(...rgb);
    if (max - Math.min(...rgb) < 40 || max < 40) continue;
    const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
    const bucket = buckets.get(key) ?? { count: 0, sum: [0, 0, 0] };
    bucket.count += 1;
    bucket.sum = [bucket.sum[0] + rgb[0], bucket.sum[1] + rgb[1], bucket.sum[2] + rgb[2]];
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count).map((b) => b.sum.map((c) => c / b.count) as Rgb);
  const chosen: Rgb[] = [];
  for (const rgb of ranked) {
    if (chosen.length === 3) break;
    if (chosen.every((other) => distance(other, rgb) > 80)) chosen.push(rgb);
  }
  const colors = [...new Set(chosen.map((rgb) => readableOnWhite(rgbToHex(rgb))))];
  const base = colors[0];
  for (let shade = 0.8; base && colors.length < 3; shade -= 0.2) {
    colors.push(rgbToHex(hexToRgb(base).map((c) => c * shade) as Rgb));
  }
  return colors;
}

/** Lê a logo publicada num canvas pequeno e devolve as sugestões; sem acesso à imagem (CORS, rede), devolve vazio. */
export function paletteFromImage(url: string): Promise<string[]> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return resolve([]);
        context.drawImage(image, 0, 0, 64, 64);
        resolve(paletteFromPixels(context.getImageData(0, 0, 64, 64).data));
      } catch {
        resolve([]);
      }
    };
    image.onerror = () => resolve([]);
    image.src = url;
  });
}
