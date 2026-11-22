import { describe, expect, it, vi } from "vitest";
import { baseCrop, clampCenter, cropRect, encodeUnderLimit, formatBytes, outputName, targetSize } from "./image-compress";

const blobOf = (size: number) => ({ size }) as Blob;

describe("cropRect", () => {
  it("zoom 1 usa a maior área 4:3 e centraliza", () => {
    expect(baseCrop(4000, 3000, 4 / 3)).toEqual({ w: 4000, h: 3000 });
    const wide = cropRect(3000, 1000, 4 / 3, { zoom: 1, cx: 0.5, cy: 0.5 });
    expect(wide.sw).toBeCloseTo(1333.33, 1);
    expect(wide.sh).toBe(1000);
    expect(wide.sx).toBeCloseTo(833.33, 1);
    const tall = cropRect(1000, 3000, 4 / 3, { zoom: 1, cx: 0.5, cy: 0.5 });
    expect(tall.sw).toBe(1000);
    expect(tall.sh).toBe(750);
    expect(tall.sy).toBe(1125);
  });

  it("zoom 2 encolhe o recorte à metade e respeita o centro", () => {
    const r = cropRect(4000, 3000, 4 / 3, { zoom: 2, cx: 0.5, cy: 0.5 });
    expect(r).toEqual({ sx: 1000, sy: 750, sw: 2000, sh: 1500 });
    const left = cropRect(4000, 3000, 4 / 3, { zoom: 2, cx: 0.25, cy: 0.5 });
    expect(left.sx).toBe(0);
  });

  it("nunca sai da imagem, mesmo com centro e zoom fora do limite", () => {
    const r = cropRect(4000, 3000, 4 / 3, { zoom: 9, cx: 5, cy: -5 });
    expect(r.sw).toBe(1000);
    expect(r.sx).toBe(3000);
    expect(r.sy).toBe(0);
    expect(clampCenter(4000, 3000, 4 / 3, { zoom: 2, cx: 0, cy: 1 })).toEqual({ zoom: 2, cx: 0.25, cy: 0.75 });
  });

  it("capa 3:1 e logo 1:1", () => {
    expect(cropRect(3000, 3000, 3, { zoom: 1, cx: 0.5, cy: 0.5 })).toEqual({ sx: 0, sy: 1000, sw: 3000, sh: 1000 });
    expect(cropRect(2000, 1000, 1, { zoom: 1, cx: 0.5, cy: 0.5 })).toEqual({ sx: 500, sy: 0, sw: 1000, sh: 1000 });
  });
});

describe("targetSize", () => {
  it("reduz a 1600x1200 e não amplia imagem pequena", () => {
    expect(targetSize(4000, 4 / 3, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(targetSize(800, 4 / 3, 1600)).toEqual({ width: 800, height: 600 });
    expect(targetSize(3000, 1, 512)).toEqual({ width: 512, height: 512 });
    expect(targetSize(3000, 3, 1600)).toEqual({ width: 1600, height: 533 });
  });
});

describe("encodeUnderLimit", () => {
  it("para na primeira qualidade que cabe", async () => {
    const encode = vi.fn(async (_w: number, _h: number, q: number) => blobOf(q >= 0.9 ? 1_500_000 : q >= 0.8 ? 900_000 : 500_000));
    const out = await encodeUnderLimit(encode, 1600, 1200, 4 / 3);
    expect(encode.mock.calls.map((c) => c[2])).toEqual([0.9, 0.8]);
    expect(out).toMatchObject({ quality: 0.8, width: 1600, height: 1200 });
  });

  it("reduz as dimensões quando a qualidade mínima não basta", async () => {
    const encode = vi.fn(async (w: number) => blobOf(w > 1300 ? 2_000_000 : 800_000));
    const out = await encodeUnderLimit(encode, 1600, 1200, 4 / 3);
    expect(out.width).toBe(1156);
    expect(out.height).toBe(867);
    expect(out.quality).toBe(0.9);
    expect(encode).toHaveBeenCalledTimes(9);
  });

  it("sem como caber, devolve a menor tentativa e termina", async () => {
    const out = await encodeUnderLimit(async (w) => blobOf(w * 10_000), 400, 300, 4 / 3);
    expect(out.blob.size).toBeGreaterThan(1024 * 1024);
    expect(out.width).toBe(340);
  });

  it("encoder sem resultado falha com mensagem", async () => {
    await expect(encodeUnderLimit(async () => null, 100, 100, 1)).rejects.toThrow("Não foi possível comprimir a imagem.");
  });
});

describe("formatos", () => {
  it("formatBytes e outputName", () => {
    expect(formatBytes(655_360)).toBe("640 KB");
    expect(formatBytes(1_258_291)).toBe("1,2 MB");
    expect(outputName("prato.final.PNG", "image/webp")).toBe("prato.final.webp");
    expect(outputName("a.heic", "image/jpeg")).toBe("a.jpg");
  });
});
