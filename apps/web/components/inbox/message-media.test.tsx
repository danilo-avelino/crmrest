import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MessageDto } from "@dishdesk/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageMedia } from "./message-media";

vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ download: () => Promise.reject(new Error("x")) }) }));

const audio = (media: object) =>
  ({ id: "m1", conversationId: "c1", type: "AUDIO", content: { media: { mimeType: "audio/ogg", ...media } } }) as unknown as MessageDto;

function show(message: MessageDto) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageMedia message={message} />
    </QueryClientProvider>,
  );
}

describe("áudio com transcrição", () => {
  afterEach(cleanup);

  it("mostra o texto transcrito", () => {
    show(audio({ transcription: "manda com catupiry" }));
    expect(screen.getByText("manda com catupiry")).toBeTruthy();
  });
  it("sem provedor: indisponível", () => {
    show(audio({ transcription: "pending_provider" }));
    expect(screen.getByText("Transcrição indisponível por enquanto")).toBeTruthy();
  });
  it("áudio longo demais", () => {
    show(audio({ storeError: "too_long", seconds: 222 }));
    expect(screen.getByText("Áudio longo demais (3:42)")).toBeTruthy();
  });
  it("sem os campos novos, nada além do player", () => {
    show(audio({}));
    expect(screen.queryByText(/Transcri/)).toBeNull();
  });
});
