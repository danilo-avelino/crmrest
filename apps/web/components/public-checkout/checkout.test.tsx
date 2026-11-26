import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCartMemory, storageKey } from "@/lib/public-cart";
import { type CheckoutState, checkoutKey, EMPTY_CHECKOUT } from "@/lib/public-checkout";
import type { PublicMenuStore } from "@/lib/public-menu";
import { AddressStep } from "./address-step";
import { Checkout } from "./checkout";
import { IdentifyStep } from "./identify-step";
import { PaymentCheckout } from "./payment";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, back: vi.fn() }) }));

const store: PublicMenuStore = {
  name: "Forno da Vila",
  logoUrl: null,
  coverUrl: null,
  accentColor: "#8E2F1B",
  brandTheme: false,
  city: "São Paulo",
  address: "Rua Aspicuelta, 120",
  phone: "(11) 3456-7890",
  cnpj: null,
  about: null,
  weekHours: null,
  closesAt: null,
  status: "open",
  nextOpening: null,
  feeRange: { minCents: 500, maxCents: 1200 },
  freeDeliveryFromCents: null,
  minOrderCents: 0,
  pickupEnabled: true,
  deliveryEta: { minMinutes: 40, maxMinutes: 50 },
  paymentMethods: ["cash", "credit", "debit", "pix_on_delivery"],
  schedulingEnabled: true,
};

const okQuote = { ok: true, mode: "DELIVERY", feeCents: 790, areaFeeCents: 790, freeDelivery: false, missingForFreeCents: null, minOrderCents: 0, missingForMinimumCents: 0, eta: { minMinutes: 40, maxMinutes: 50 } };

type Route = (url: string, init?: RequestInit) => unknown;
function api(routes: Record<string, Route>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find((path) => url.endsWith(path));
    if (!key) return new Response("{}", { status: 404 });
    const result = routes[key]!(url, init);
    return result instanceof Response ? result : Response.json(result);
  });
}

beforeEach(() => {
  localStorage.clear();
  resetCartMemory();
  push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAddress(fetchMock: ReturnType<typeof api>, onDone = vi.fn()) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <AddressStep slug="forno" store={store} subtotalCents={5000} saved={[]} canSave={false} current={null} onBack={vi.fn()} onPickup={vi.fn()} onDone={onDone} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Não sei meu CEP/ }));
  return onDone;
}

describe("endereço (W10, R3, R12)", () => {
  it("mostra todos os erros de uma vez, em português, em cada campo e no resumo; referência não é obrigatória", async () => {
    const fetchMock = api({});
    renderAddress(fetchMock);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continuar" })));

    const summary = screen.getByRole("alert");
    expect(summary.textContent).toContain("Faltam 4 campos para continuar");
    for (const label of ["Rua", "Número", "Bairro", "Cidade"]) expect(summary.textContent).toContain(label);
    expect(summary.textContent).not.toContain("Ponto de referência");
    expect(screen.getByText("Informe a rua.")).toBeTruthy();
    expect(screen.getByText('Informe o número ou marque "Sem número".')).toBeTruthy();
    expect(screen.getByText("Informe o bairro.")).toBeTruthy();
    expect(screen.getByText("Informe a cidade.")).toBeTruthy();
    expect(screen.getByLabelText("Bairro").getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("form#address-form")?.hasAttribute("novalidate")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"Sem número" e sem referência: cota a entrega pelo bairro e segue', async () => {
    const fetchMock = api({ "/delivery-quote": () => okQuote });
    const onDone = renderAddress(fetchMock);
    fireEvent.change(screen.getByLabelText("Rua"), { target: { value: "Rua Harmonia" } });
    fireEvent.click(screen.getByLabelText("Sem número"));
    fireEvent.change(screen.getByLabelText("Bairro"), { target: { value: "Vila Madalena" } });
    fireEvent.change(screen.getByLabelText("Cidade"), { target: { value: "São Paulo" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continuar" })));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [choice, quote] = onDone.mock.calls[0]!;
    expect(choice).toMatchObject({ kind: "new", address: { street: "Rua Harmonia", number: "", noNumber: true, reference: "", district: "Vila Madalena" } });
    expect(quote).toEqual({ feeCents: 790, eta: { minMinutes: 40, maxMinutes: 50 }, freeDelivery: false });
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string);
    expect(body).toEqual({ mode: "DELIVERY", subtotalCents: 5000, address: { district: "Vila Madalena", lat: null, lng: null } });
  });

  it("fora da área: avisa com Retirar na loja e Falar com a loja", async () => {
    const fetchMock = api({ "/delivery-quote": () => ({ ok: false, code: "OUT_OF_AREA", message: "Ainda não entregamos nesse bairro." }) });
    const onDone = renderAddress(fetchMock);
    fireEvent.change(screen.getByLabelText("Rua"), { target: { value: "Rua X" } });
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Bairro"), { target: { value: "Longe" } });
    fireEvent.change(screen.getByLabelText("Cidade"), { target: { value: "São Paulo" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continuar" })));

    expect(await screen.findByText("Não entregamos nesse endereço.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retirar na loja" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Falar com a loja" }).getAttribute("href")).toBe("https://wa.me/551134567890");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("endereços salvos só depois do código (R1, R10)", () => {
  const line = { id: "l1", itemId: "i", name: "Pizza", sizeId: null, sizeName: null, half: null, options: {}, optionLines: [], quantity: 1, note: null, unitCents: 5000, totalCents: 5000, pricedAt: 0 };
  const saved = { id: "a1", label: "Casa", street: "Rua Harmonia", number: "412", district: "Vila Madalena", city: "São Paulo", state: "SP", zipCode: null, complement: null };

  function seed(state: CheckoutState) {
    localStorage.setItem(storageKey("forno"), JSON.stringify({ v: 1, lines: [line] }));
    localStorage.setItem(checkoutKey("forno"), JSON.stringify({ v: 1, state }));
  }

  it("com o código: os salvos aparecem no topo, com o rótulo", async () => {
    seed({ ...EMPTY_CHECKOUT, identity: { kind: "otp", name: "Ana", phone: "+5511987654321" }, mode: "DELIVERY", when: { kind: "now" } });
    const fetchMock = api({ "/me": () => ({ name: "Ana", phone: "+5511987654321", addresses: [saved], orders: [] }), "/delivery-quote": () => okQuote });
    vi.stubGlobal("fetch", fetchMock);
    render(<Checkout slug="forno" store={store} scheduleRequested={false} />);

    expect(await screen.findByText("Seus endereços")).toBeTruthy();
    expect(screen.getByText("Casa")).toBeTruthy();
    expect(screen.getByText("Rua Harmonia, 412")).toBeTruthy();
  });

  it("visitante: nem consulta a sessão e não vê endereço salvo", async () => {
    seed({ ...EMPTY_CHECKOUT, identity: { kind: "guest", name: "Bia", phone: "+5511912345678" }, mode: "DELIVERY", when: { kind: "now" } });
    const fetchMock = api({ "/me": () => ({ name: "Ana", phone: "+5511987654321", addresses: [saved], orders: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<Checkout slug="forno" store={store} scheduleRequested={false} />);

    expect(await screen.findByText("Novo endereço")).toBeTruthy();
    expect(screen.queryByText("Seus endereços")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/me"))).toBe(false);
  });

  it("sessão vencida (401): volta para a identificação", async () => {
    seed({ ...EMPTY_CHECKOUT, identity: { kind: "otp", name: "Ana", phone: "+5511987654321" }, mode: "DELIVERY", when: { kind: "now" } });
    vi.stubGlobal("fetch", api({ "/me": () => new Response("{}", { status: 401 }) }));
    render(<Checkout slug="forno" store={store} scheduleRequested={false} />);
    expect(await screen.findByText("Qual é o seu celular?")).toBeTruthy();
  });
});

describe("identificação (W8)", () => {
  function renderIdentify(fetchMock: ReturnType<typeof api>) {
    vi.stubGlobal("fetch", fetchMock);
    const onVerified = vi.fn(async () => {});
    render(<IdentifyStep slug="forno" storeName="Forno da Vila" initialPhone="" backHref="/c/forno" onVerified={onVerified} onGuest={vi.fn()} />);
    return onVerified;
  }

  it("código errado mostra as tentativas que restam; opt-in desmarcado vai na conferência", async () => {
    const fetchMock = api({
      "/otp/request": () => ({ available: true, expiresInSeconds: 600, resendInSeconds: 45 }),
      "/otp/verify": () => new Response(JSON.stringify({ message: "Código inválido" }), { status: 400 }),
    });
    renderIdentify(fetchMock);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Celular com DDD"), { target: { value: "11987654321" } });
    expect((screen.getByLabelText("Celular com DDD") as HTMLInputElement).value).toBe("(11) 98765-4321");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Enviar código pelo WhatsApp" })));

    expect(await screen.findByText("Digite o código")).toBeTruthy();
    expect(screen.getByText("Reenviar em 0:45")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Dígito 1"), { target: { value: "123456" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirmar" })));

    expect(await screen.findByText("Código errado. Restam 4 tentativas.")).toBeTruthy();
    const verify = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/otp/verify"))!;
    expect(JSON.parse(verify[1]!.body as string)).toEqual({ phone: "+5511987654321", code: "123456", marketingOptIn: false });
  });

  it("sem WhatsApp da loja: avisa que o envio falhou e mantém a saída de visitante", async () => {
    renderIdentify(api({ "/otp/request": () => ({ available: false }) }));
    fireEvent.change(screen.getByLabelText("Celular com DDD"), { target: { value: "11987654321" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Enviar código pelo WhatsApp" })));

    expect(await screen.findByText("Não conseguimos enviar o código.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continuar sem salvar meus dados" })).toBeTruthy();
  });

  it("celular inválido não pede código", async () => {
    const fetchMock = api({});
    renderIdentify(fetchMock);
    fireEvent.change(screen.getByLabelText("Celular com DDD"), { target: { value: "1134567890" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Enviar código pelo WhatsApp" })));
    expect(screen.getByText("Informe um celular com DDD, como (11) 98765-4321.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pagamento (W11): sem Pix online", () => {
  const line = { id: "l1", itemId: "i", name: "Pizza", sizeId: null, sizeName: null, half: null, options: {}, optionLines: [], quantity: 1, note: null, unitCents: 5000, totalCents: 5000, pricedAt: 0 };
  const state: CheckoutState = { ...EMPTY_CHECKOUT, identity: { kind: "otp", name: "Ana", phone: "+5511987654321" }, mode: "PICKUP", when: { kind: "now" } };

  function renderPayment(methods: PublicMenuStore["paymentMethods"]) {
    localStorage.setItem(storageKey("forno"), JSON.stringify({ v: 1, lines: [line] }));
    localStorage.setItem(checkoutKey("forno"), JSON.stringify({ v: 1, state }));
    render(<PaymentCheckout slug="forno" store={{ ...store, paymentMethods: methods }} />);
  }

  it("lista dinheiro, crédito, débito e Pix na maquininha na retirada; não mostra Pix nem Pagar agora nem Em breve", async () => {
    renderPayment(["cash", "credit", "debit", "pix_on_delivery"]);
    expect(await screen.findByText("Pagar na retirada")).toBeTruthy();
    for (const name of ["Dinheiro", "Cartão de crédito", "Cartão de débito", "Pix na maquininha"]) expect(screen.getByRole("radio", { name: new RegExp(name) })).toBeTruthy();
    expect(screen.queryByText("Pagar agora")).toBeNull();
    expect(screen.queryByText("Pix")).toBeNull(); // só o "Pix na maquininha", que é na entrega
    expect(screen.queryByText(/Em breve/)).toBeNull();
  });

  it("só as formas do cardápio aparecem", async () => {
    renderPayment(["debit"]);
    await screen.findByText("Pagar na retirada");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /Cartão de débito/ })).toBeTruthy();
  });
});
