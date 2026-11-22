import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuItem, MenuTree } from "@/lib/menu";
import { ItemEditor } from "./item-editor";
import { MenuList } from "./menu-list";

const uploadPhoto = vi.fn();
const call = vi.fn();
const toast = vi.fn();
const push = vi.fn();
let tree: MenuTree;
let actionError: string | null = null;

vi.mock("@/components/auth/auth-provider", () => ({
  useAuth: () => ({ request: vi.fn(), session: { context: { tenants: [{ id: "t1" }] }, tenants: [{ id: "t1", slug: "loja" }] } }),
}));
vi.mock("@/components/menu/use-menu", () => ({
  useTenantId: () => "t1",
  useMenu: () => ({ isPending: false, isError: false, data: tree }),
  useMenuActions: () => ({ call, uploadPhoto, error: actionError, setError: vi.fn(), tenantId: "t1" }),
}));
vi.mock("@/components/settings/use-settings", () => ({ useSettingsList: () => ({ data: [] }) }));
vi.mock("@/components/menu/ifood-import-request", () => ({ IfoodImportRequestButton: () => null, IfoodImportRequestStatus: () => null }));
vi.mock("@/components/menu/menu-header-actions", () => ({ MenuHeaderMenus: () => null }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
// Enquadramento falso: "Usar foto" entrega um arquivo já recortado.
vi.mock("@/components/common/image-crop-dialog", () => ({
  ImageCropDialog: ({ file, onConfirm }: { file: File | null; onConfirm: (file: File) => Promise<unknown> | void }) =>
    file ? (
      <button type="button" onClick={() => onConfirm(new File(["x"], "recorte.jpg", { type: "image/jpeg" }))}>
        Usar foto
      </button>
    ) : null,
}));

const item = (patch: Partial<MenuItem> = {}): MenuItem => ({
  id: "i1",
  categoryId: "c1",
  name: "Pizza Calabresa",
  description: null,
  priceCents: 4500,
  photoUrl: null,
  sortOrder: 0,
  active: true,
  soldOut: false,
  allowsHalf: true,
  ingredients: ["calabresa"],
  allergens: [],
  servesPeople: null,
  tags: [],
  synonyms: [],
  aiNotes: null,
  sizes: [],
  optionGroups: [],
  availabilities: [],
  pairsWith: [],
  ...patch,
});
const treeOf = (items: MenuItem[]): MenuTree => ({
  menu: { id: "m1", name: "Cardápio", active: true },
  optionGroups: [],
  categories: [{ id: "c1", name: "Pizzas", description: null, sortOrder: 0, active: true, allowsHalf: true, halfPricing: "MAX", availabilities: [], items }],
});
const pick = (label: string) => fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } });

afterEach(() => {
  cleanup();
  uploadPhoto.mockReset();
  call.mockReset();
  toast.mockReset();
  push.mockReset();
  actionError = null;
});

describe("foto direto da lista do cardápio", () => {
  it("o quadrado sem foto abre o seletor, enquadra e envia sem sair da lista", async () => {
    tree = treeOf([item()]);
    uploadPhoto.mockResolvedValue({ photoUrl: "https://x/foto.jpg" });
    render(<MenuList />);
    const picker = screen.getByLabelText("Escolher foto de Pizza Calabresa") as HTMLInputElement;
    const open = vi.spyOn(picker, "click");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar foto: Pizza Calabresa" }));
    expect(open).toHaveBeenCalledTimes(1);

    pick("Escolher foto de Pizza Calabresa");
    fireEvent.click(await screen.findByRole("button", { name: "Usar foto" }));
    await waitFor(() => expect(uploadPhoto).toHaveBeenCalledTimes(1));
    expect(uploadPhoto.mock.calls[0]?.[0]).toBe("i1");
    expect((uploadPhoto.mock.calls[0]?.[1] as File).name).toBe("recorte.jpg");
    expect(push).not.toHaveBeenCalled();
  });

  it("mostra Carregando e bloqueia o duplo clique enquanto envia", async () => {
    tree = treeOf([item()]);
    let finish: (value: unknown) => void = () => undefined;
    uploadPhoto.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<MenuList />);
    pick("Escolher foto de Pizza Calabresa");
    fireEvent.click(await screen.findByRole("button", { name: "Usar foto" }));
    const thumb = await screen.findByRole("button", { name: "Adicionar foto: Pizza Calabresa" });
    await waitFor(() => expect((thumb as HTMLButtonElement).disabled).toBe(true));
    expect(thumb.getAttribute("aria-busy")).toBe("true");
    expect(thumb.getAttribute("title")).toBe("Carregando…");
    finish({ photoUrl: "https://x/foto.jpg" });
    await waitFor(() => expect((thumb as HTMLButtonElement).disabled).toBe(false));
  });

  it("a ação do aviso Sem foto abre o mesmo seletor", () => {
    tree = treeOf([item()]);
    render(<MenuList />);
    const picker = screen.getByLabelText("Escolher foto de Pizza Calabresa") as HTMLInputElement;
    const open = vi.spyOn(picker, "click");
    fireEvent.click(screen.getByRole("button", { name: "Enviar foto" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("item com foto não ganha botão de foto", () => {
    tree = treeOf([item({ photoUrl: "https://x/foto.jpg" })]);
    render(<MenuList />);
    expect(screen.queryByRole("button", { name: /Adicionar foto/ })).toBeNull();
    expect(screen.queryByLabelText(/Escolher foto de/)).toBeNull();
  });

  it("erro do envio aparece junto do item", () => {
    tree = treeOf([item()]);
    actionError = "Foto acima de 1 MB.";
    render(<MenuList />);
    expect(screen.getAllByText("Foto acima de 1 MB.").length).toBeGreaterThan(0);
  });
});

describe("foto no editor do item (F2-14)", () => {
  it("item existente: salva a foto na hora, confirma e não marca alterações não salvas", async () => {
    tree = treeOf([item()]);
    uploadPhoto.mockResolvedValue({ photoUrl: "https://x/foto.jpg" });
    render(<ItemEditor id="i1" />);
    expect(screen.queryByText("A foto é salva junto com o item")).toBeNull();
    pick("Escolher foto");
    fireEvent.click(await screen.findByRole("button", { name: "Usar foto" }));
    await waitFor(() => expect(uploadPhoto).toHaveBeenCalledWith("i1", expect.any(File)));
    expect(await screen.findByText("Foto salva")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Foto salva");
    expect(screen.queryByText("Alterações não salvas")).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("a foto não mexe em outras alterações do formulário", async () => {
    tree = treeOf([item()]);
    uploadPhoto.mockResolvedValue({ photoUrl: "https://x/foto.jpg" });
    render(<ItemEditor id="i1" />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pizza Nova" } });
    expect(screen.getByText("Alterações não salvas")).toBeTruthy();
    pick("Escolher foto");
    fireEvent.click(await screen.findByRole("button", { name: "Usar foto" }));
    await screen.findByText("Foto salva");
    expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Pizza Nova");
    expect(screen.getByText("Alterações não salvas")).toBeTruthy();
  });

  it("item novo: não envia na hora e avisa que a foto vai junto com o item", async () => {
    tree = treeOf([]);
    render(<ItemEditor id="novo" />);
    expect(screen.getByText("A foto é salva junto com o item")).toBeTruthy();
    pick("Escolher foto");
    fireEvent.click(await screen.findByRole("button", { name: "Usar foto" }));
    await waitFor(() => expect(screen.getByText(/será enviada ao salvar/)).toBeTruthy());
    expect(uploadPhoto).not.toHaveBeenCalled();
    expect(screen.queryByText("Foto salva")).toBeNull();
  });
});
