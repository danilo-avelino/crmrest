import type { OrderListItem } from "@dishdesk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderDetails } from "./order-list";

vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request: vi.fn().mockResolvedValue({ channel: null, contactName: null }) }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const canceled = (outsideAt: string | null) =>
  ({
    id: "pedido-1",
    displayCode: "8650",
    channelType: "CARDAPIO_WEB",
    status: "CANCELED",
    items: [],
    deliveryFee: "0.00",
    events: [],
    history: { orders: 4, bySource: [{ channelType: "CARDAPIO_WEB", orders: 4 }] },
    nextAction: null,
    cancelable: false,
    dispute: null,
    alert: null,
    platform: null,
    cancellation: {
      id: "pedido-1",
      displayCode: "8650",
      channelType: "CARDAPIO_WEB",
      restaurantName: null,
      total: "71.00",
      placedAt: "2026-10-02T22:10:00.000Z",
      reason: "Não veio retirar o pedido",
      imported: false,
      fraud: null,
      address: null,
      outsideAt,
    },
  }) as unknown as OrderListItem;

function show(order: OrderListItem) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OrderDetails order={order} />
    </QueryClientProvider>,
  );
}

describe("bloco Cancelamento da aba Pedidos", () => {
  afterEach(cleanup);

  it("cancelado fora do Dish Desk: diz onde e quando", () => {
    show(canceled("2026-10-03T00:30:00.000Z"));
    expect(screen.getByText(/^Cancelado no Cardápio Web, fora do Dish Desk, em \d{2}\/\d{2} às \d{2}:\d{2}\.$/)).toBeTruthy();
  });

  it("cancelado pela equipe, ou sem como afirmar: não mostra a linha", () => {
    show(canceled(null));
    expect(screen.getByText("Não veio retirar o pedido")).toBeTruthy();
    expect(screen.queryByText(/fora do Dish Desk/)).toBeNull();
  });
});
