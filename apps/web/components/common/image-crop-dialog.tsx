"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  clampCenter,
  compressCrop,
  type CropView,
  cropRect,
  formatBytes,
  type LoadedImage,
  loadImage,
  MAX_ZOOM,
  MIN_ZOOM,
  outputName,
} from "@/lib/image-compress";

type Props = {
  /** Arquivo escolhido; null fecha a tela. */
  file: File | null;
  /** Proporção do recorte (largura/altura): 4/3 foto, 3 capa, 1 logo. */
  aspect: number;
  /** Largura máxima da imagem final, em pixels. */
  maxWidth: number;
  title: string;
  onCancel: () => void;
  /** Recebe a imagem já recortada e comprimida (≤ 1 MB). A tela só libera os botões quando a Promise termina. */
  onConfirm: (file: File) => Promise<unknown> | void;
};

const NUDGE = 0.02;

/**
 * Tela de enquadramento (F2-14): arrastar para posicionar, controle de zoom, prévia na proporção final
 * e o tamanho do arquivo depois da compressão. Setas movem o recorte; + e - mudam o zoom.
 */
export function ImageCropDialog({ file, aspect, maxWidth, title, onCancel, onConfirm }: Props) {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [view, setView] = useState<CropView>({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Troca de arquivo: zera a prévia antes de carregar a nova imagem.
    /* eslint-disable react-hooks/set-state-in-effect */
    setImage(null);
    setSize(null);
    setError(null);
    setView({ zoom: 1, cx: 0.5, cy: 0.5 });
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!file) return;
    let cancelled = false;
    let loaded: LoadedImage | null = null;
    loadImage(file).then(
      (result) => {
        if (cancelled) return result.release();
        loaded = result;
        setImage(result);
      },
      (failure: unknown) => !cancelled && setError(failure instanceof Error ? failure.message : "Não foi possível abrir a imagem."),
    );
    return () => {
      cancelled = true;
      loaded?.release();
    };
  }, [file]);

  // Tamanho final estimado: recalcula depois que o recorte para de mudar.
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      compressCrop(image, view, aspect, maxWidth).then(
        (out) => !cancelled && setSize(out.blob.size),
        () => !cancelled && setSize(null),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [image, view, aspect, maxWidth]);

  /** Move o recorte em fração do tamanho dele (1 = uma largura/altura inteira). */
  const move = (fx: number, fy: number) => {
    if (!image) return;
    setView((current) => {
      const r = cropRect(image.width, image.height, aspect, current);
      return clampCenter(image.width, image.height, aspect, {
        ...current,
        cx: current.cx + (fx * r.sw) / image.width,
        cy: current.cy + (fy * r.sh) / image.height,
      });
    });
  };
  const zoomTo = (zoom: number) => {
    if (image) setView((current) => clampCenter(image.width, image.height, aspect, { ...current, zoom }));
  };

  const rect = image ? cropRect(image.width, image.height, aspect, view) : null;

  async function confirm() {
    if (!image) return;
    setError(null);
    try {
      const out = await compressCrop(image, view, aspect, maxWidth);
      await onConfirm(new File([out.blob], outputName(file?.name ?? "imagem", out.blob.type), { type: out.blob.type }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível preparar a imagem.");
    }
  }

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="w-[520px] p-5">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-1">Arraste para posicionar e use o zoom. A imagem é comprimida para até 1 MB antes do envio.</DialogDescription>

        <div
          ref={frame}
          role="group"
          tabIndex={0}
          aria-label="Área de recorte. Use as setas para mover e + ou - para o zoom."
          className="relative mt-4 w-full touch-none overflow-hidden rounded-lg bg-surface-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          style={{ aspectRatio: String(aspect), cursor: image ? "grab" : "default" }}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const last = drag.current;
            const box = frame.current?.getBoundingClientRect();
            if (!last || !box || !box.width || !box.height) return;
            // Arrastar para a direita leva a imagem para a direita: o recorte anda no sentido contrário.
            move(-(event.clientX - last.x) / box.width, -(event.clientY - last.y) / box.height);
            drag.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onKeyDown={(event) => {
            const step = (event.shiftKey ? 5 : 1) * NUDGE;
            const arrows: Record<string, [number, number]> = {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step],
            };
            const delta = arrows[event.key];
            if (delta) {
              event.preventDefault();
              move(delta[0], delta[1]);
            } else if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              zoomTo(view.zoom + 0.1);
            } else if (event.key === "-") {
              event.preventDefault();
              zoomTo(view.zoom - 0.1);
            }
          }}
        >
          {image && rect ? (
            // eslint-disable-next-line @next/next/no-img-element -- prévia local do recorte
            <img
              src={image.url}
              alt="Prévia do recorte"
              draggable={false}
              className="pointer-events-none absolute max-w-none select-none"
              style={{
                width: `${(image.width / rect.sw) * 100}%`,
                height: `${(image.height / rect.sh) * 100}%`,
                left: `${(-rect.sx / rect.sw) * 100}%`,
                top: `${(-rect.sy / rect.sh) * 100}%`,
              }}
            />
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-ink-3">{error ?? "Carregando…"}</div>
          )}
        </div>

        <label className="mt-4 flex items-center gap-3 text-[13px] font-medium text-ink">
          Zoom
          <input
            type="range"
            aria-label="Zoom"
            className="h-1 flex-1 accent-ink"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={view.zoom}
            disabled={!image}
            onChange={(event) => zoomTo(Number(event.target.value))}
          />
        </label>

        <div className="mt-3 min-h-5 text-xs text-ink-3" aria-live="polite">
          {error && image ? (
            <span className="text-tomate">{error}</span>
          ) : size !== null ? (
            <>Tamanho final: <span className="font-medium tabular-nums text-ink">{formatBytes(size)}</span></>
          ) : image ? (
            "Calculando o tamanho…"
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button disabled={!image} onClick={confirm}>
            Usar foto
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
