/**
 * Recorte e compressão de imagem no navegador (F2-14), antes do envio.
 * A parte pura (retângulo do recorte, tamanho final, laço de qualidade) não toca em DOM e tem teste;
 * `loadImage` e `compressCrop` usam canvas e só rodam no navegador.
 */

export const MAX_UPLOAD_BYTES = 1024 * 1024;

/** Tipo de recorte de cada envio: proporção (largura/altura) e largura máxima da saída. */
export const CROP_PRESETS = {
  photo: { aspect: 4 / 3, maxWidth: 1600 },
  cover: { aspect: 3, maxWidth: 1600 },
  logo: { aspect: 1, maxWidth: 512 },
} as const;

export type CropView = { zoom: number; cx: number; cy: number };
export type CropRect = { sx: number; sy: number; sw: number; sh: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Maior retângulo da proporção que cabe na imagem (zoom 1). */
export function baseCrop(natW: number, natH: number, aspect: number): { w: number; h: number } {
  return natW / natH > aspect ? { w: natH * aspect, h: natH } : { w: natW, h: natW / aspect };
}

/**
 * Retângulo de origem, em pixels da imagem, para o zoom e o centro escolhidos.
 * `cx` e `cy` são o centro do recorte em fração da imagem (0 a 1); o recorte nunca sai da imagem.
 */
export function cropRect(natW: number, natH: number, aspect: number, view: CropView): CropRect {
  const base = baseCrop(natW, natH, aspect);
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const sw = base.w / zoom;
  const sh = base.h / zoom;
  const sx = clamp(view.cx * natW - sw / 2, 0, natW - sw);
  const sy = clamp(view.cy * natH - sh / 2, 0, natH - sh);
  return { sx, sy, sw, sh };
}

/** Mesma vista com o centro (fração da imagem) trazido para onde o recorte cabe, para o zoom dado. */
export function clampCenter(natW: number, natH: number, aspect: number, view: CropView): CropView {
  const { sx, sy, sw, sh } = cropRect(natW, natH, aspect, view);
  return { zoom: clamp(view.zoom, MIN_ZOOM, MAX_ZOOM), cx: (sx + sw / 2) / natW, cy: (sy + sh / 2) / natH };
}

/** Tamanho final: no máximo `maxWidth` de largura, na proporção, sem ampliar o que veio menor. */
export function targetSize(sw: number, aspect: number, maxWidth: number): { width: number; height: number } {
  const width = Math.max(1, Math.round(Math.min(maxWidth, sw)));
  return { width, height: Math.max(1, Math.round(width / aspect)) };
}

export const QUALITIES = [0.9, 0.8, 0.7, 0.6] as const;
const SHRINK = 0.85;
const MIN_WIDTH = 320;

export type Encode = (width: number, height: number, quality: number) => Promise<Blob | null>;
export type Encoded = { blob: Blob; width: number; height: number; quality: number };

/**
 * Codifica começando em 0,9 e baixando a qualidade até caber em `maxBytes`; se nem a mínima (0,6) couber,
 * reduz as dimensões em 15% e tenta de novo. Sem como caber (largura abaixo de 320 px), devolve a menor tentativa.
 */
export async function encodeUnderLimit(encode: Encode, width: number, height: number, aspect: number, maxBytes = MAX_UPLOAD_BYTES): Promise<Encoded> {
  let w = width;
  let h = height;
  let smallest: Encoded | null = null;
  for (;;) {
    for (const quality of QUALITIES) {
      const blob = await encode(w, h, quality);
      if (!blob) throw new Error("Não foi possível comprimir a imagem.");
      const result = { blob, width: w, height: h, quality };
      if (blob.size <= maxBytes) return result;
      if (!smallest || blob.size < smallest.blob.size) smallest = result;
    }
    const next = Math.round(w * SHRINK);
    if (next < MIN_WIDTH || next >= w) return smallest!;
    w = next;
    h = Math.max(1, Math.round(w / aspect));
  }
}

/** "640 KB" ou "1,2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export type LoadedImage = { source: CanvasImageSource; width: number; height: number; url: string; release: () => void };

/** Abre o arquivo como imagem (a orientação EXIF vale); falha com mensagem em português. */
export function loadImage(file: Blob): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, url, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não foi possível abrir a imagem. Use JPG, PNG ou WEBP."));
    };
    img.src = url;
  });
}

/** Pede WebP; o navegador que não sabe codificar devolve PNG, e aí cai para JPEG (com fundo branco). */
function canvasEncoder(image: LoadedImage, rect: CropRect): Encode {
  let mime: "image/webp" | "image/jpeg" = "image/webp";
  return async (width, height, quality) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    const toBlob = (type: string) => new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality));
    const draw = (background: boolean) => {
      ctx.clearRect(0, 0, width, height);
      if (background) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(image.source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);
    };
    draw(mime === "image/jpeg");
    let blob = await toBlob(mime);
    if (mime === "image/webp" && blob && blob.type !== "image/webp") {
      mime = "image/jpeg";
      draw(true);
      blob = await toBlob(mime);
    }
    return blob;
  };
}

/** Recorta a imagem no retângulo, reduz ao tamanho final e comprime até caber em 1 MB. */
export async function compressCrop(image: LoadedImage, view: CropView, aspect: number, maxWidth: number, maxBytes = MAX_UPLOAD_BYTES): Promise<Encoded> {
  const rect = cropRect(image.width, image.height, aspect, view);
  const { width, height } = targetSize(rect.sw, aspect, maxWidth);
  return encodeUnderLimit(canvasEncoder(image, rect), width, height, aspect, maxBytes);
}

/** Nome do arquivo final: o original sem a extensão, com a do formato gerado. */
export function outputName(original: string, mime: string): string {
  const base = original.replace(/\.[^./\\]+$/, "") || "imagem";
  return `${base}.${mime === "image/jpeg" ? "jpg" : "webp"}`;
}
