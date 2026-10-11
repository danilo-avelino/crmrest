"use client";

import type { MessageDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, FileIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MEDIA_LABEL: Partial<Record<MessageDto["type"], string>> = {
  IMAGE: "Imagem",
  AUDIO: "Áudio",
  VIDEO: "Vídeo",
  DOCUMENT: "Documento",
  STICKER: "Figurinha",
};

const mediaPath = (message: MessageDto) => `/conversations/${message.conversationId}/messages/${message.id}/media`;

/**
 * Mídia de uma mensagem: imagem e figurinha aparecem no balão, áudio ganha um player, vídeo e documento são baixados.
 * O arquivo vem da plataforma (WhatsApp, Instagram) a cada vez, e ela só o guarda por alguns dias.
 */
export function MessageMedia({ message }: { message: MessageDto }) {
  const label = MEDIA_LABEL[message.type];
  if (!label) return null;
  if (!message.content.media) return <MediaLabel label={label} />;
  if (message.type === "IMAGE" || message.type === "STICKER") return <Picture message={message} label={label} />;
  if (message.type === "AUDIO") return <Voice message={message} label={label} />;
  return <Download message={message} label={label} filename={message.content.media.filename} />;
}

function MediaLabel({ label, detail, children }: { label: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-2 text-[12px]">
      <span className="flex items-center gap-1.5 opacity-80">
        <FileIcon className="size-3.5 shrink-0" aria-hidden />
        {label}
        {detail && ` · ${detail}`}
      </span>
      {children}
    </div>
  );
}

const UNAVAILABLE = "não está mais disponível";

/** O arquivo da mensagem; fica na memória enquanto a conversa estiver em uso. */
function useMedia(message: MessageDto) {
  const { download } = useAuth();
  const { data: blob, isError: failed } = useQuery({
    queryKey: ["media", message.id],
    queryFn: () => download(mediaPath(message)),
    staleTime: Infinity,
    retry: false,
    // Arquivo que a plataforma já apagou não volta: não adianta pedir de novo a cada foco da janela.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return { blob, failed };
}

/** Liga o arquivo a um <img> ou <audio> por um endereço temporário, liberado quando o elemento sai da tela. */
function useBlobSource(blob: Blob | undefined) {
  return useCallback(
    (element: HTMLImageElement | HTMLAudioElement | null) => {
      if (!element || !blob) return;
      const url = URL.createObjectURL(blob);
      element.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [blob],
  );
}

function Picture({ message, label }: { message: MessageDto; label: string }) {
  const { blob, failed } = useMedia(message);
  const source = useBlobSource(blob);
  const [open, setOpen] = useState(false);
  if (failed) return <MediaLabel label={label} detail={UNAVAILABLE} />;
  const sticker = message.type === "STICKER";
  return (
    <>
      {/* Tamanho fixo: a conversa não pula quando a imagem termina de carregar. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!blob}
        aria-label={`Ampliar ${label.toLowerCase()}`}
        className={cn(
          "mb-1 flex items-center justify-center overflow-hidden rounded-md bg-surface-2 text-[11px] text-ink-3",
          sticker ? "size-28" : "h-44 w-60",
        )}
      >
        {blob ? (
          // eslint-disable-next-line @next/next/no-img-element -- arquivo em memória, não passa pelo otimizador de imagens
          <img ref={source} alt={label} className={cn("size-full", sticker ? "object-contain" : "object-cover")} />
        ) : (
          "Carregando…"
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-label={label} className="w-auto">
          {/* eslint-disable-next-line @next/next/no-img-element -- idem */}
          <img ref={source} alt={label} className="max-h-[85vh] max-w-full" />
        </DialogContent>
      </Dialog>
    </>
  );
}

function Voice({ message, label }: { message: MessageDto; label: string }) {
  const { blob, failed } = useMedia(message);
  const source = useBlobSource(blob);
  if (failed) return <MediaLabel label={label} detail={UNAVAILABLE} />;
  if (!blob) return <MediaLabel label={label} detail="carregando…" />;
  return <audio ref={source} controls aria-label={label} className="mb-1 h-9 w-72" />;
}

/** Vídeo e documento: baixados pelo atendente, com o nome original quando o canal informa. */
function Download({ message, label, filename }: { message: MessageDto; label: string; filename?: string }) {
  const { download } = useAuth();
  const [failed, setFailed] = useState(false);

  const save = async () => {
    try {
      const url = URL.createObjectURL(await download(mediaPath(message)));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename ?? label;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    }
  };

  if (failed) return <MediaLabel label={label} detail={UNAVAILABLE} />;
  return (
    <MediaLabel label={label} detail={filename}>
      <Button variant="outline" size="xs" onClick={save}>
        <DownloadIcon aria-hidden />
        Baixar
      </Button>
    </MediaLabel>
  );
}
