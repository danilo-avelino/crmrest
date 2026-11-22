import type { Env } from "../config/env.js";

/** Transcrição de um áudio do cliente (F5-02). O texto volta como o cliente falou; vazio quando não deu para entender. */
export interface TranscriptionProvider {
  readonly configured: boolean;
  transcribe(input: { bytes: Uint8Array; mimeType: string; vocabulary: string }): Promise<{ text: string; seconds: number | null }>;
}

/** Vocabulário do cardápio para o `prompt` do Whisper: nomes de itens e categorias, até ~800 caracteres (o limite é 224 tokens). */
export function menuVocabulary(names: string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  let out = "Pedido de delivery em português do Brasil. Cardápio:";
  for (const name of unique) {
    if (out.length + name.length + 2 > 800) break;
    out += ` ${name},`;
  }
  return out.replace(/,$/, ".");
}

/** Formato do áudio como o OpenRouter pede (`input_audio.format`). O WhatsApp manda ogg/opus. */
const FORMAT: Record<string, string> = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/webm": "webm" };

/**
 * Whisper large-v3-turbo pelo OpenRouter (D4, escolha do usuário em 22/11/2026: barato, cerca de US$ 0,0002 por minuto,
 * e bom em português). `POST /audio/transcriptions` com o áudio em base64; o vocabulário do cardápio vai como o prompt do
 * Groq, que serve esse modelo.
 */
export class OpenRouterTranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly env: Pick<Env, "OPENROUTER_API_KEY" | "OPENROUTER_API_URL" | "TRANSCRIPTION_MODEL">) {}

  get configured(): boolean {
    return Boolean(this.env.OPENROUTER_API_KEY);
  }

  async transcribe(input: { bytes: Uint8Array; mimeType: string; vocabulary: string }): Promise<{ text: string; seconds: number | null }> {
    if (!this.env.OPENROUTER_API_KEY) throw new Error("Transcrição sem provedor configurado");
    const mime = input.mimeType.split(";")[0]!.trim();
    const response = await fetch(`${this.env.OPENROUTER_API_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.env.TRANSCRIPTION_MODEL,
        input_audio: { data: Buffer.from(input.bytes).toString("base64"), format: FORMAT[mime] ?? "ogg" },
        language: "pt",
        ...(input.vocabulary ? { provider: { options: { groq: { prompt: input.vocabulary } } } } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const body = (await response.json()) as { text?: string; duration?: number; usage?: { seconds?: number } };
    const seconds = typeof body.duration === "number" ? body.duration : typeof body.usage?.seconds === "number" ? body.usage.seconds : null;
    return { text: (body.text ?? "").trim(), seconds };
  }
}
