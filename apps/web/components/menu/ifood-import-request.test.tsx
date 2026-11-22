import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IfoodImportRequestDialog } from "./ifood-import-request";

const request = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request }) }));
vi.mock("@/components/menu/use-menu", () => ({ useTenantId: () => "t1" }));

const renderDialog = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IfoodImportRequestDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("pedido de importação do iFood", () => {
  it("nome e CNPJ inválidos mostram os dois erros e não enviam", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("CNPJ da loja"), { target: { value: "11.222.333/0001-82" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }));
    expect(await screen.findByText("Informe o nome da loja no iFood.")).toBeTruthy();
    expect(screen.getByText("Informe um CNPJ válido.")).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("envia o pedido e mostra a confirmação", async () => {
    request.mockResolvedValue({});
    renderDialog();
    fireEvent.change(screen.getByLabelText("Nome da loja no iFood"), { target: { value: "Pizzaria do Teste" } });
    fireEvent.change(screen.getByLabelText("CNPJ da loja"), { target: { value: "11.222.333/0001-81" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/menu/t1/import-requests", { method: "POST", body: { storeName: "Pizzaria do Teste", cnpj: "11.222.333/0001-81" } }),
    );
    expect(await screen.findByText(/Pedido enviado/)).toBeTruthy();
  });

  it("erro da API aparece no formulário", async () => {
    const { ApiError } = await import("@/lib/api");
    request.mockRejectedValue(new ApiError(409, "Já existe um pedido de importação aguardando a equipe."));
    renderDialog();
    fireEvent.change(screen.getByLabelText("Nome da loja no iFood"), { target: { value: "Pizzaria" } });
    fireEvent.change(screen.getByLabelText("CNPJ da loja"), { target: { value: "11222333000181" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }));
    expect(await screen.findByText("Já existe um pedido de importação aguardando a equipe.")).toBeTruthy();
  });
});
