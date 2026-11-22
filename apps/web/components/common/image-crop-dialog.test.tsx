import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/image-compress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/image-compress")>()),
  loadImage: vi.fn(async () => ({ source: {}, width: 4000, height: 3000, url: "blob:x", release: vi.fn() })),
  compressCrop: vi.fn(async () => ({ blob: new Blob([new Uint8Array(655_360)], { type: "image/webp" }), width: 1600, height: 1200, quality: 0.9 })),
}));

import * as lib from "@/lib/image-compress";
import { ImageCropDialog } from "./image-crop-dialog";

const file = new File(["x"], "prato.png", { type: "image/png" });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function open(onConfirm: (file: File) => Promise<unknown> = vi.fn(async () => undefined), onCancel = vi.fn()) {
  render(<ImageCropDialog file={file} aspect={4 / 3} maxWidth={1600} title="Enquadrar a foto" onCancel={onCancel} onConfirm={onConfirm} />);
  await screen.findByAltText("Prévia do recorte");
  return { onConfirm, onCancel };
}

describe("ImageCropDialog", () => {
  it("mostra o título, o zoom e o tamanho final depois da compressão", async () => {
    await open();
    expect(screen.getByText("Enquadrar a foto")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Zoom" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(await screen.findByText("640 KB")).toBeTruthy();
  });

  it("setas movem o recorte e + aumenta o zoom", async () => {
    await open();
    const img = screen.getByAltText("Prévia do recorte");
    const before = img.style.left;
    const area = screen.getByRole("group");
    fireEvent.keyDown(area, { key: "+" });
    const zoomed = (screen.getByRole("slider", { name: "Zoom" }) as HTMLInputElement).value;
    expect(Number(zoomed)).toBeCloseTo(1.1, 5);
    fireEvent.keyDown(area, { key: "ArrowRight" });
    expect(screen.getByAltText("Prévia do recorte").style.left).not.toBe(before);
  });

  it("Usar foto comprime, entrega o arquivo e barra o duplo clique", async () => {
    let finish!: () => void;
    const onConfirm = vi.fn<(file: File) => Promise<void>>(() => new Promise<void>((done) => (finish = done)));
    await open(onConfirm);
    const button = screen.getByRole("button", { name: "Usar foto" });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const sent = onConfirm.mock.calls[0]![0] as File;
    expect(sent.name).toBe("prato.webp");
    expect(sent.type).toBe("image/webp");
    expect(lib.compressCrop).toHaveBeenCalled();
    expect(screen.getAllByRole("button").some((b) => b.textContent === "Carregando…")).toBe(true);
    await act(async () => finish());
  });

  it("Cancelar chama onCancel", async () => {
    const { onCancel } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("imagem que não abre mostra a mensagem e mantém Usar foto desabilitado", async () => {
    vi.mocked(lib.loadImage).mockRejectedValueOnce(new Error("Não foi possível abrir a imagem. Use JPG, PNG ou WEBP."));
    render(<ImageCropDialog file={file} aspect={1} maxWidth={512} title="Enquadrar a logo" onCancel={() => {}} onConfirm={async () => {}} />);
    expect(await screen.findByText("Não foi possível abrir a imagem. Use JPG, PNG ou WEBP.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Usar foto" }).hasAttribute("data-disabled")).toBe(true);
  });
});
