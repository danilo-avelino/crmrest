import type { MessageDto } from "@dishdesk/shared";

type AudioMedia = NonNullable<MessageDto["content"]["media"]>;

export type AudioNote = {
  state: "text" | "busy" | "unavailable" | "failed" | "too_long" | "store_failed";
  head: string;
  body?: string;
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/**
 * Nota sob o balão de áudio (módulo Cardápio): transcrição, andamento ou falha.
 * Sem `storeError` nem `transcription` devolve null, e o balão fica como era.
 */
export function audioNote(media: Pick<AudioMedia, "storeError" | "transcription" | "seconds">): AudioNote | null {
  const { storeError, transcription, seconds } = media;
  if (storeError === "too_long" || storeError === "too_large") {
    const length = seconds ? ` (${clock(seconds)})` : "";
    return {
      state: "too_long",
      head: `Áudio longo demais${length}`,
      body: "A IA não transcreve áudios acima de 2 min. Ouça e responda.",
    };
  }
  if (storeError) return { state: "store_failed", head: "Não foi possível guardar o áudio" };
  if (!transcription) return null;
  if (transcription === "pending_provider") return { state: "unavailable", head: "Transcrição indisponível por enquanto" };
  if (transcription === "pending") {
    return { state: "busy", head: "Transcrevendo…", body: "O texto aparece aqui em alguns segundos." };
  }
  if (transcription === "failed") {
    return { state: "failed", head: "Não deu para transcrever", body: "Pedimos para o cliente repetir por escrito." };
  }
  return { state: "text", head: "Transcrição", body: transcription };
}
