import { describe, expect, it } from "vitest";
import { audioNote } from "./audio-transcription";

describe("audioNote", () => {
  it("sem os campos novos não mostra nada", () => {
    expect(audioNote({})).toBeNull();
  });
  it("sem provedor: indisponível", () => {
    expect(audioNote({ transcription: "pending_provider" })?.state).toBe("unavailable");
  });
  it("em andamento", () => {
    expect(audioNote({ transcription: "pending" })).toMatchObject({ state: "busy", head: "Transcrevendo…" });
  });
  it("texto transcrito", () => {
    expect(audioNote({ transcription: "manda com catupiry" })).toEqual({
      state: "text",
      head: "Transcrição",
      body: "manda com catupiry",
    });
  });
  it("falha de transcrição pede para repetir", () => {
    expect(audioNote({ transcription: "failed" })?.body).toContain("Pedimos para o cliente repetir");
  });
  it("longo demais, com duração", () => {
    expect(audioNote({ storeError: "too_long", seconds: 222 })?.head).toBe("Áudio longo demais (3:42)");
    expect(audioNote({ storeError: "too_large" })?.state).toBe("too_long");
  });
  it("falha ao guardar", () => {
    expect(audioNote({ storeError: "failed" })).toMatchObject({ state: "store_failed", head: "Não foi possível guardar o áudio" });
  });
});
