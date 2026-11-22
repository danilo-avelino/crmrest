import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { comparison, FunnelDashboard, rangeOf } from "./funnel-dashboard";

const request = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({
  useAuth: () => ({ request, session: { context: { tenants: [{ id: "t1" }] }, tenants: [{ id: "t1", slug: "loja" }] } }),
}));

const steps = (visitors: number[]) =>
  ["PAGE_VIEW", "VIEW_CONTENT", "ADD_TO_CART", "INITIATE_CHECKOUT", "ADD_PAYMENT_INFO", "PURCHASE"].map((stage, i) => ({ stage, events: visitors[i], visitors: visitors[i] }));

const dto = (patch = {}) => ({
  summary: { steps: steps([100, 60, 30, 20, 10, 8]), searches: 0 },
  bySource: [
    { source: "instagram", stage: "PAGE_VIEW", visitors: 60 },
    { source: "instagram", stage: "PURCHASE", visitors: 5 },
    { source: "direto", stage: "PAGE_VIEW", visitors: 40 },
    { source: "direto", stage: "PURCHASE", visitors: 3 },
  ],
  byChannel: { WEB: 5, WHATSAPP: 3 },
  orders: 8,
  revenueCents: 59000,
  averageTicketCents: 7375,
  daily: [],
  previous: { orders: 5, revenueCents: 50000 },
  ticketBySource: [{ source: "instagram", orders: 5, revenueCents: 40000 }],
  unattributedOrders: 3,
  ...patch,
});

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FunnelDashboard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("funil do cardápio (F7-06)", () => {
  it("rangeOf: mês vai do dia 1 até hoje (Brasília) e 7 dias termina amanhã 00:00", () => {
    const now = Date.parse("2026-11-21T15:00:00Z");
    expect(rangeOf(0, now)).toMatchObject({ from: "2026-11-01T03:00:00.000Z", to: "2026-11-22T03:00:00.000Z", days: 21 });
    expect(rangeOf(7, now)).toMatchObject({ from: "2026-11-15T03:00:00.000Z", to: "2026-11-22T03:00:00.000Z", days: 7 });
  });

  it("comparison: alta, queda e sem base", () => {
    expect(comparison(11800, 10000)).toEqual({ text: "+18% que o período anterior", up: true });
    expect(comparison(8000, 10000)).toEqual({ text: "-20% que o período anterior", up: false });
    expect(comparison(8000, 0)).toBeNull();
  });

  it("mostra comparação, ticket por origem com traço e aviso de pedidos sem origem", async () => {
    request.mockResolvedValue(dto());
    show();
    await screen.findByText("+18% que o período anterior");
    expect(screen.getByText(/ticket R\$\s*80,00/)).toBeTruthy();
    expect(screen.getByText(/ticket —/)).toBeTruthy();
    expect(screen.getByText(/3 pedidos sem origem registrada ficam fora/)).toBeTruthy();
    expect(screen.getByText(/A maior queda/)).toBeTruthy();
  });

  it("aba Mês refaz a consulta e sem eventos mostra o estado vazio", async () => {
    request.mockResolvedValue(dto());
    show();
    await screen.findByText("Pedidos do cardápio");
    request.mockResolvedValue(dto({ summary: { steps: steps([0, 0, 0, 0, 0, 0]), searches: 0 }, orders: 0, revenueCents: 0 }));
    fireEvent.click(screen.getByRole("tab", { name: "Mês" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await screen.findByText("Ainda não há visitas no cardápio");
  });
});
