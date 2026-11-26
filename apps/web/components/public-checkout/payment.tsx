"use client";

import { selectCoupon, setCouponCode, useCouponPreview } from "@/lib/coupons";
import { browserSessionId, currentAttribution } from "@/lib/attribution";
import { contextToken, saveContextToken } from "@/lib/menu-context";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { CartProvider, type CartLine, useCart } from "@/lib/public-cart";
import { type CheckoutState, firstMissing, loadCheckout, saveCheckout, storeContactLink, whenLabel } from "@/lib/public-checkout";
import { money, type PublicMenuStore } from "@/lib/public-menu";
import {
  changeHint,
  EMPTY_PAYMENT,
  fetchPix,
  formatCpf,
  orderPlaced,
  orderRequestOf,
  PAY_LATER,
  type PaymentChoice,
  type PaymentErrors,
  type PendingPix,
  parseMoney,
  payLaterTitle,
  pendingOrderKey,
  pendingPix,
  pixCountdown,
  type PixView,
  type PlaceOutcome,
  placeOrder,
  type PriceChange,
  reviewModel,
  savePendingPix,
  type ValidPayment,
  validatePayment,
} from "@/lib/public-order";
import { cn } from "@/lib/utils";
import { AccentButton, CheckoutFooter, CheckoutHeader, inputClass, RadioDot } from "./ui";

const noSubscribe = () => () => {};

/** Pagamento (W11), revisão (W12) e erros do envio (W13). Só no navegador: o checkout e a sacola vivem no localStorage. */
export function PaymentCheckout({ slug, store }: { slug: string; store: PublicMenuStore }) {
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  return (
    <CartProvider slug={slug}>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col bg-paper pb-32">
        {hydrated ? (
          <PaymentFlow slug={slug} store={store} />
        ) : (
          <div className="flex flex-col gap-3 p-4" aria-label="Carregando" aria-busy>
            <div className="h-8 w-2/3 animate-pulse rounded-lg bg-surface-2" />
            <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
          </div>
        )}
      </div>
    </CartProvider>
  );
}

type Saved = CheckoutState & { payment?: PaymentChoice; notes?: string };

function PaymentFlow({ slug, store }: { slug: string; store: PublicMenuStore }) {
  const router = useRouter();
  const cart = useCart();
  const menuHref = `/c/${encodeURIComponent(slug)}`;
  const checkoutHref = `${menuHref}/checkout`;
  const [state, setState] = useState<Saved>(() => loadCheckout(slug) as Saved);
  const [screen, setScreen] = useState<"payment" | "review">("payment");
  const [errors, setErrors] = useState<PaymentErrors>({});
  const [outcome, setOutcome] = useState<Exclude<PlaceOutcome, { kind: "ok" } | { kind: "pix" }> | null>(null);
  // Pix aberto (W14): volta ao QR Code depois de recarregar a página.
  const [pix, setPix] = useState<PendingPix | null>(() => pendingPix(slug));

  const payment = state.payment ?? EMPTY_PAYMENT;
  const notes = state.notes ?? "";
  const update = (change: Partial<Saved>) =>
    setState((current) => {
      const next = { ...current, ...change };
      saveCheckout(slug, next);
      return next;
    });

  const subtotalCents = cart.lines.reduce((sum, l) => sum + l.totalCents, 0);
  const baseFeeCents = state.mode === "DELIVERY" ? (state.quote?.feeCents ?? 0) : 0;
  // Cupom da tag escolhido na sacola (só com o código): prévia aqui; o servidor confere no pedido.
  const preview = useCouponPreview(slug, subtotalCents, baseFeeCents, cart.lines, state.mode);
  const totalCents = preview.totalCents;

  /** Pedido criado (na entrega ou Pix pago): guarda o acesso, limpa a sacola e abre o acompanhamento. */
  const finish = (id: string, token: string) => {
    orderPlaced(slug, id, token);
    savePendingPix(slug, null);
    saveContextToken(slug, null);
    update({ payment: EMPTY_PAYMENT, notes: "", when: null });
    cart.clear();
    selectCoupon(slug, null);
    setCouponCode(slug, null);
    router.push(`${menuHref}/pedido/${id}`);
  };

  if (pix) {
    return (
      <PixScreen
        slug={slug}
        pix={pix}
        onPaid={finish}
        onAgain={async () => {
          savePendingPix(slug, null);
          setPix(null);
          setScreen("review");
        }}
        onChangePayment={() => {
          savePendingPix(slug, null);
          setPix(null);
          setScreen("payment");
        }}
      />
    );
  }

  if (cart.lines.length === 0) {
    return (
      <>
        <CheckoutHeader title="Pagamento" backHref={menuHref} />
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
          <h2 className="m-0 font-heading text-title font-semibold">Sua sacola está vazia</h2>
          <Link href={menuHref} className="flex h-11 items-center rounded-lg bg-ink px-4 font-medium text-paper no-underline">
            Ver o cardápio
          </Link>
        </div>
      </>
    );
  }
  if (firstMissing(state) !== "payment") {
    return (
      <>
        <CheckoutHeader title="Pagamento" backHref={checkoutHref} />
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
          <p className="m-0 text-ink-2">Falta escolher a entrega antes do pagamento.</p>
          <Link href={checkoutHref} className="flex h-11 items-center rounded-lg bg-ink px-4 font-medium text-paper no-underline">
            Voltar à entrega
          </Link>
        </div>
      </>
    );
  }

  const valid = validatePayment(payment, totalCents);

  // A revisão só abre com o pagamento válido (o estado salvo pode ter ficado pela metade).
  if (screen === "payment" || !valid.ok) {
    return (
      <PaymentStep
        store={store}
        mode={state.mode}
        totalCents={totalCents}
        choice={payment}
        errors={errors}
        onBack={() => router.push(checkoutHref)}
        onChange={(choice) => {
          update({ payment: choice });
          setErrors({});
        }}
        onContinue={() => {
          if (!valid.ok) setErrors(valid.errors);
          else setScreen("review");
        }}
      />
    );
  }

  const send = async () => {
    const body = {
      ...orderRequestOf({ state, lines: cart.lines, payment: valid, notes, idempotencyKey: pendingOrderKey(slug) }),
      sessionId: browserSessionId(),
      couponId: preview.couponId,
      couponCode: preview.couponCode,
      attribution: currentAttribution(slug),
      contextToken: contextToken(slug),
    };
    const result = await placeOrder(slug, body);
    if (result.kind === "ok") {
      finish(result.id, result.token);
      return;
    }
    if (result.kind === "pix") {
      savePendingPix(slug, result.pix);
      setPix(result.pix);
      return;
    }
    setOutcome(result);
  };

  return (
    <>
      <ReviewStep
        slug={slug}
        store={store}
        state={state}
        lines={cart.lines}
        payment={valid}
        notes={notes}
        priceChanges={outcome?.kind === "priceChanged" ? outcome.changes : []}
        onNotes={(value) => update({ notes: value })}
        onBack={() => setScreen("payment")}
        onAcceptPrices={() => {
          if (outcome?.kind !== "priceChanged") return;
          for (const change of outcome.changes) {
            const line = cart.lines.find((l) => l.id === change.lineId);
            if (line) cart.update({ ...line, totalCents: change.toCents, unitCents: Math.round(change.toCents / line.quantity), pricedAt: Date.now() });
          }
          setOutcome(null);
        }}
        onSend={send}
      />
      {outcome && outcome.kind !== "priceChanged" && (
        <SendError
          outcome={outcome}
          store={store}
          lines={cart.lines}
          menuHref={menuHref}
          checkoutHref={checkoutHref}
          totalCents={totalCents}
          onRetry={send}
          onRemove={(id) => cart.remove(id)}
          onSchedule={(slot) => {
            update({ when: { kind: "scheduled", slot } });
            setOutcome(null);
          }}
          onPayment={() => {
            setOutcome(null);
            setScreen("payment");
          }}
          onClose={() => setOutcome(null)}
        />
      )}
    </>
  );
}

// ---------- W11 ----------

function PaymentStep({
  store,
  mode,
  totalCents,
  choice,
  errors,
  onBack,
  onChange,
  onContinue,
}: {
  store: PublicMenuStore;
  mode: CheckoutState["mode"];
  totalCents: number;
  choice: PaymentChoice;
  errors: PaymentErrors;
  onBack: () => void;
  onChange: (choice: PaymentChoice) => void;
  onContinue: () => void;
}) {
  const later = PAY_LATER.filter((m) => store.paymentMethods.includes(m.id));
  // A API só lista o Pix quando a plataforma ligou o recebedor da Pagar.me da loja.
  const pixOnline = store.paymentMethods.includes("pix");
  const pixOn = choice.method === "pix";
  const changeCents = parseMoney(choice.changeFor);
  const contact = storeContactLink(store.phone);
  return (
    <>
      <CheckoutHeader title="Como você vai pagar?" onBack={onBack} right={money(totalCents)} step={2} />
      <div className="flex flex-col gap-2.5 px-3 py-4">
        <div
          role="radiogroup"
          aria-label="Forma de pagamento"
          aria-describedby={errors.method ? "payment-error" : undefined}
          className={cn("flex flex-col gap-2 rounded-[10px]", errors.method && "border-[1.5px] border-tomate bg-tomate-lt p-3")}
        >
          {errors.method && (
            <div id="payment-error" role="alert" className="font-semibold text-tomate">
              {errors.method}
            </div>
          )}
          {pixOnline && (
            <>
              <div className="text-[12px] font-semibold tracking-[.02em] text-ink-2 uppercase">Pagar agora</div>
              <div className={cn("rounded-lg bg-surface", pixOn ? "border-2 border-ink" : "border border-rule")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={pixOn}
                  onClick={() => onChange({ ...choice, method: "pix" })}
                  className="flex min-h-14 w-full items-center gap-3 px-3 text-left"
                >
                  <RadioDot on={pixOn} />
                  <span className="flex-1 text-[14px] font-medium">Pix</span>
                  <span className="text-[12px] text-ink-3">aprovação na hora</span>
                </button>
                {pixOn && (
                  <div className="flex flex-col gap-1.5 pr-3 pb-3.5 pl-11">
                    <label htmlFor="cpf" className="font-medium">
                      CPF de quem paga
                    </label>
                    <input
                      id="cpf"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="000.000.000-00"
                      value={choice.cpf ?? ""}
                      onChange={(e) => onChange({ ...choice, cpf: formatCpf(e.target.value) })}
                      aria-invalid={errors.cpf ? true : undefined}
                      aria-describedby="cpf-msg"
                      className={cn(inputClass, "font-medium tabular-nums", errors.cpf && "border-tomate")}
                    />
                    <div id="cpf-msg" role={errors.cpf ? "alert" : undefined} className={cn("text-[12px]", errors.cpf ? "font-medium text-tomate" : "text-ink-3")}>
                      {errors.cpf ?? "O banco pede o CPF para gerar o Pix. O pedido entra assim que o pagamento cair."}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          <div className="text-[12px] font-semibold tracking-[.02em] text-ink-2 uppercase">{payLaterTitle(mode)}</div>
          {later.length === 0 && (
            <p className="m-0 text-ink-2">
              A loja ainda não aceita pagamento {mode === "PICKUP" ? "na retirada" : "na entrega"} pelo cardápio.
              {contact && (
                <>
                  {" "}
                  <a href={contact} target="_blank" rel="noreferrer" className="font-medium underline">
                    Falar com a loja
                  </a>
                </>
              )}
            </p>
          )}
          {later.map((m) => {
            const on = choice.method === m.id;
            return (
              <div key={m.id} className={cn("rounded-lg bg-surface", on ? "border-2 border-ink" : "border border-rule")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange({ ...choice, method: m.id })}
                  className="flex min-h-14 w-full items-center gap-3 px-3 text-left"
                >
                  <RadioDot on={on} />
                  <span className="flex-1 text-[14px] font-medium">{m.name}</span>
                  <span className="text-[12px] text-ink-3">{m.note}</span>
                </button>
                {on && m.id === "cash" && (
                  <div className="flex flex-col gap-2.5 pr-3 pb-3.5 pl-11">
                    <div className="font-medium" id="change-q">
                      Precisa de troco?
                    </div>
                    <div className="flex gap-2" role="group" aria-labelledby="change-q">
                      {([true, false] as const).map((yes) => (
                        <button
                          key={String(yes)}
                          type="button"
                          aria-pressed={choice.needsChange === yes}
                          onClick={() => onChange({ ...choice, needsChange: yes })}
                          className={cn(
                            "h-11 flex-1 rounded-md font-medium",
                            choice.needsChange === yes ? "bg-ink text-paper" : "border border-rule bg-surface text-ink",
                          )}
                        >
                          {yes ? "Sim" : "Não"}
                        </button>
                      ))}
                    </div>
                    {choice.needsChange && (
                      <>
                        <label htmlFor="troco" className="font-medium">
                          Troco para quanto?
                        </label>
                        <div className="relative">
                          <span className="absolute top-[11px] left-3 text-ink-3">R$</span>
                          <input
                            id="troco"
                            inputMode="decimal"
                            value={choice.changeFor}
                            onChange={(e) => onChange({ ...choice, changeFor: e.target.value })}
                            aria-invalid={errors.change ? true : undefined}
                            aria-describedby="troco-msg"
                            className={cn(inputClass, "pl-9 font-medium")}
                          />
                        </div>
                      </>
                    )}
                    {errors.change ? (
                      <div id="troco-msg" role="alert" className="text-[12px] font-medium text-tomate">
                        {errors.change}
                      </div>
                    ) : (
                      choice.needsChange &&
                      changeCents !== null &&
                      changeCents > totalCents && (
                        <div id="troco-msg" className="text-[12px] font-medium text-success-ink">
                          {changeHint(changeCents, totalCents, mode)}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <CheckoutFooter>
        <AccentButton onClick={onContinue} disabled={later.length === 0 && !pixOnline}>
          Revisar pedido
        </AccentButton>
      </CheckoutFooter>
    </>
  );
}

// ---------- W14 ----------

/**
 * Pix gerado: QR Code, copia e cola e o prazo. A tela consulta a API a cada 3 s (ela confere na Pagar.me); pago, o pedido
 * nasce no servidor e a tela abre o acompanhamento. Vencido, o cliente gera outro Pix ou troca a forma de pagamento.
 */
function PixScreen({
  slug,
  pix,
  onPaid,
  onAgain,
  onChangePayment,
}: {
  slug: string;
  pix: PendingPix;
  onPaid: (orderId: string, orderToken: string) => void;
  onAgain: () => Promise<void>;
  onChangePayment: () => void;
}) {
  const [view, setView] = useState<PixView | null>(null);
  const [missing, setMissing] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [copied, setCopied] = useState(false);
  const paidRef = useRef(onPaid);
  useEffect(() => {
    paidRef.current = onPaid;
  }, [onPaid]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const next = await fetchPix(slug, pix);
        if (stop) return;
        if (!next) {
          setMissing(true);
          return;
        }
        setView(next);
        if (next.status === "PAID" && next.orderId && next.orderToken) {
          paidRef.current(next.orderId, next.orderToken);
          return;
        }
        if (next.status !== "PENDING" && next.status !== "PAID") return;
      } catch {
        // Rede caiu: tenta de novo no próximo ciclo; o pagamento continua valendo na Pagar.me.
      }
      if (!stop) timer = setTimeout(check, 3000);
    };
    void check();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [slug, pix]);

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  const status = view?.status ?? "PENDING";
  const expiresAt = view?.expiresAt ?? pix.expiresAt;
  const left = pixCountdown(expiresAt, now);
  const over = status === "EXPIRED" || status === "CANCELED" || missing;
  const paid = status === "PAID";
  const qrCode = view ? view.qrCode : pix.qrCode;
  const qrCodeUrl = view ? view.qrCodeUrl : pix.qrCodeUrl;

  const copy = async () => {
    if (!qrCode) return;
    try {
      await navigator.clipboard.writeText(qrCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <CheckoutHeader title="Pague com Pix" onBack={over ? onChangePayment : undefined} />
      <div className="flex flex-col gap-2.5 p-3">
        <div className={cn(card, "flex items-center gap-3 px-3 py-3.5")}>
          <div className="flex-1">
            <div className="text-[12px] text-ink-3">Valor do Pix</div>
            <div className="font-heading text-[24px] font-bold tabular-nums">{money(view?.amountCents ?? pix.amountCents)}</div>
          </div>
          {paid ? (
            <span className="rounded-full bg-success-lt px-2.5 py-1 text-[12px] font-semibold text-success-ink">Pago · criando o pedido</span>
          ) : over ? (
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[12px] font-semibold text-ink-2">{status === "CANCELED" ? "Cancelado" : "Venceu"}</span>
          ) : (
            <span className="rounded-full bg-warning-lt px-2.5 py-1 text-[12px] font-semibold text-warning-ink tabular-nums" aria-live="polite">
              Aguardando · vence em {left}
            </span>
          )}
        </div>

        {over ? (
          <div className={cn(card, "flex flex-col gap-3 p-4")}>
            <h2 className="m-0 font-heading text-title font-semibold">{status === "CANCELED" ? "Este Pix foi cancelado" : "Este Pix venceu sem pagamento"}</h2>
            <p className="m-0 text-ink-2">Nenhum valor foi cobrado e o pedido não foi feito. Sua sacola continua salva.</p>
            <AccentButton onClick={onAgain} className="h-12">
              Gerar outro Pix
            </AccentButton>
            <button type="button" onClick={onChangePayment} className="flex h-12 items-center justify-center rounded-md border border-rule font-medium text-ink">
              Trocar a forma de pagamento
            </button>
          </div>
        ) : (
          <div className={cn(card, "flex flex-col items-center gap-3 p-4")}>
            {qrCodeUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- QR Code da Pagar.me, imagem externa de uso único
              <img src={qrCodeUrl} alt="QR Code do Pix" width={208} height={208} className="size-52 rounded-md border border-rule" />
            )}
            <div className="w-full">
              <div className="mb-1 text-[12px] font-medium text-ink-2">Pix copia e cola</div>
              <div className="w-full truncate rounded-md border border-rule bg-surface-2 px-3 py-2.5 font-mono text-[12px] text-ink-2">{qrCode}</div>
            </div>
            <Button className="h-12 w-full" onClick={copy} disabled={!qrCode || paid}>
              {copied ? "Código copiado" : "Copiar código Pix"}
            </Button>
            <ol className="m-0 flex w-full flex-col gap-1 pl-5 text-ink-2">
              <li>Abra o app do seu banco e escolha pagar com Pix.</li>
              <li>Cole o código ou leia o QR Code.</li>
              <li>Pronto: o pedido entra sozinho quando o pagamento cair.</li>
            </ol>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- W12 ----------

const card = "rounded-lg border border-rule bg-surface";

function ReviewStep({
  slug,
  store,
  state,
  lines,
  payment,
  notes,
  priceChanges,
  onNotes,
  onBack,
  onAcceptPrices,
  onSend,
}: {
  slug: string;
  store: PublicMenuStore;
  state: CheckoutState;
  lines: CartLine[];
  payment: ValidPayment;
  notes: string;
  priceChanges: PriceChange[];
  onNotes: (value: string) => void;
  onBack: () => void;
  onAcceptPrices: () => void;
  onSend: () => Promise<void>;
}) {
  const menuHref = `/c/${encodeURIComponent(slug)}`;
  const checkoutHref = `${menuHref}/checkout`;
  const base = reviewModel(state, lines, payment, store, new Date());
  const preview = useCouponPreview(slug, base.subtotalCents, base.deliveryFeeCents, lines, state.mode);
  const model = { ...base, deliveryFeeCents: preview.feeCents, totalCents: preview.totalCents };
  const changed = new Map(priceChanges.map((c) => [c.lineId, c]));
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);
  return (
    <>
      <CheckoutHeader title="Revise seu pedido" onBack={onBack} step={3} />
      <div className="flex flex-col gap-2.5 p-3">
        <div className={cn(card, "flex items-center gap-3 px-3 py-3.5")}>
          <div className="flex-1">
            <div className="text-[12px] text-ink-3">{model.whenLabel}</div>
            <div className="font-heading text-[18px] font-semibold">{model.whenValue}</div>
          </div>
          <Link href={state.when?.kind === "scheduled" ? `${checkoutHref}?agendar=1` : checkoutHref} className="font-medium">
            Alterar
          </Link>
        </div>

        <div className={cn(card, "flex items-start gap-3 p-3")}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold">{model.modeTitle}</span>
              {model.addressLabel && <span className="rounded-sm bg-surface-2 px-1.5 text-[11px] font-semibold text-ink-2">{model.addressLabel}</span>}
            </div>
            {model.addressLines.map((line, i) => (
              <div key={line} className={i > 0 ? "text-ink-3" : undefined}>
                {line}
              </div>
            ))}
          </div>
          <Link href={checkoutHref} className="font-medium">
            Alterar
          </Link>
        </div>

        <div className={cn(card, "px-3")}>
          <div className="flex h-11 items-center justify-between">
            <span className="font-heading text-title font-semibold">
              {count} {count === 1 ? "item" : "itens"}
            </span>
            <Link href={menuHref} className="font-medium">
              Editar sacola
            </Link>
          </div>
          {lines.map((line) => {
            const change = changed.get(line.id);
            const opts = [line.sizeName, line.half && `½ ${line.half.name}`, ...line.optionLines.map((o) => o.name), line.note].filter(Boolean).join(" · ");
            return (
              <div key={line.id} className="flex flex-col gap-2 border-t border-[#EEE9E2] py-2.5">
                <div className="flex gap-2">
                  <span className="w-5 font-semibold">{line.quantity}×</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{line.name}</div>
                    {opts && <div className="text-[12px] text-ink-3">{opts}</div>}
                  </div>
                  <div className="text-right">
                    {change && <div className="text-[12px] text-ink-3 line-through">{money(change.fromCents)}</div>}
                    <div className="font-semibold">{money(change ? change.toCents : line.totalCents)}</div>
                  </div>
                </div>
                {change && (
                  <div role="alert" className="flex flex-col gap-2 rounded-md border border-[#F1DFB4] bg-warning-lt p-2.5 text-warning-ink">
                    <span className="font-medium">
                      O preço de {line.name} mudou de {money(change.fromCents)} para {money(change.toCents)}.
                    </span>
                    <div className="flex gap-2">
                      <Button onClick={onAcceptPrices}>Aceitar</Button>
                      <Link href={menuHref} className="flex h-9 items-center rounded-lg border border-rule bg-surface px-3.5 font-medium text-ink no-underline">
                        Voltar
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={cn(card, "flex flex-col gap-1.5 p-3")}>
          <label htmlFor="obs" className="font-medium">
            Observação do pedido <span className="font-normal text-ink-3">(opcional)</span>
          </label>
          <textarea
            id="obs"
            rows={2}
            maxLength={300}
            value={notes}
            onChange={(e) => onNotes(e.target.value)}
            placeholder="Ex.: interfone com defeito, ligar ao chegar"
            className="w-full resize-none rounded-md border border-rule px-3 py-2.5 text-[14px] outline-none focus:border-ink focus:shadow-[0_0_0_3px_rgba(26,24,20,.08)]"
          />
        </div>

        <div className={cn(card, "flex items-center gap-3 p-3")}>
          <div className="flex size-9 items-center justify-center rounded-md bg-surface-2 text-[11px] font-bold">R$</div>
          <div className="flex-1">
            <div className="font-semibold">{model.payName}</div>
            <div className="text-[12px] text-ink-3">{model.payDetail}</div>
          </div>
          <button type="button" onClick={onBack} className="font-medium underline">
            Alterar
          </button>
        </div>

        <div className={cn(card, "flex flex-col gap-1.5 p-3")}>
          <div className="flex justify-between">
            <span className="text-ink-2">Subtotal</span>
            <span>{money(model.subtotalCents)}</span>
          </div>
          {preview.label && preview.discountCents > 0 && (
            <div className="flex justify-between text-success-ink">
              <span>Cupom {preview.label}</span>
              <span>− {money(preview.discountCents)}</span>
            </div>
          )}
          {state.mode === "DELIVERY" && (
            <div className="flex justify-between">
              <span className="text-ink-2">Entrega</span>
              <span>{model.deliveryFeeCents === 0 ? "Grátis" : money(model.deliveryFeeCents)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-[#EEE9E2] pt-2 text-[16px] font-semibold">
            <span>Total</span>
            <span>{money(model.totalCents)}</span>
          </div>
        </div>
      </div>
      <CheckoutFooter>
        <AccentButton onClick={onSend} disabled={priceChanges.length > 0}>
          {priceChanges.length > 0 ? "Confirme o novo preço acima" : model.cta}
        </AccentButton>
        <div className="mt-2 text-center text-[11px] text-ink-3">Ao fazer o pedido você aceita os termos da loja.</div>
      </CheckoutFooter>
    </>
  );
}

// ---------- W13 ----------

function SendError({
  outcome,
  store,
  lines,
  menuHref,
  checkoutHref,
  totalCents,
  onRetry,
  onRemove,
  onSchedule,
  onPayment,
  onClose,
}: {
  outcome: Exclude<PlaceOutcome, { kind: "ok" } | { kind: "pix" } | { kind: "priceChanged" }>;
  store: PublicMenuStore;
  lines: CartLine[];
  menuHref: string;
  checkoutHref: string;
  totalCents: number;
  onRetry: () => Promise<void>;
  onRemove: (lineId: string) => void;
  onSchedule: (slot: NonNullable<Extract<PlaceOutcome, { kind: "closed" }>["nextSlot"]>) => void;
  onPayment: () => void;
  onClose: () => void;
}) {
  const contact = storeContactLink(store.phone);
  const secondary = "flex h-12 items-center justify-center rounded-md border border-rule font-medium text-ink no-underline";
  let title: string;
  let body: string;
  let actions: React.ReactNode;
  let extra: React.ReactNode = null;

  if (outcome.kind === "network") {
    title = "Não conseguimos enviar";
    body = "Parece que a internet caiu. Confira a conexão e tente de novo.";
    extra = (
      <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] text-ink-2">
        Seu pedido ficou guardado neste celular. Ao tentar de novo, usamos o mesmo envio: se ele já tiver chegado na loja, não é criado outro.
      </div>
    );
    actions = (
      <>
        <AccentButton onClick={onRetry} className="h-12">
          Tentar de novo
        </AccentButton>
        {contact ? (
          <a href={contact} target="_blank" rel="noreferrer" className={secondary}>
            Falar com a loja
          </a>
        ) : (
          <button type="button" onClick={onClose} className={secondary}>
            Fechar
          </button>
        )}
      </>
    );
  } else if (outcome.kind === "closed" || outcome.kind === "slot") {
    const slot = outcome.nextSlot;
    title = outcome.kind === "closed" ? "A loja fechou enquanto você pedia" : "Esse horário não está mais disponível";
    body = slot ? `${outcome.message} Sua sacola continua salva: agende para ${whenLabel(slot)}.` : `${outcome.message} Sua sacola continua salva.`;
    actions = (
      <>
        {slot && (
          <AccentButton onClick={() => onSchedule(slot)} className="h-12">
            Agendar para {whenLabel(slot)}
          </AccentButton>
        )}
        <Link href={slot ? `${checkoutHref}?agendar=1` : menuHref} className={secondary}>
          {slot ? "Ver horários" : "Voltar ao cardápio"}
        </Link>
      </>
    );
  } else if (outcome.kind === "soldOut") {
    const gone = lines.filter((l) => outcome.lineIds.includes(l.id));
    title = "Um item acabou agora";
    body = "Remova o item para fazer o pedido. O resto da sacola está garantido.";
    extra = gone.map((line) => (
      <div key={line.id} className="flex flex-col gap-2 rounded-lg border border-[#F1DFB4] bg-warning-lt px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{line.quantity}×</span>
          <span className="flex-1 font-medium text-warning-ink line-through">{line.name}</span>
          <span className="rounded-sm bg-[#E4DFD7] px-1.5 text-[11px] font-semibold text-ink-2">Esgotou</span>
        </div>
        <Button variant="outline" className="h-11" onClick={() => onRemove(line.id)}>
          Remover
        </Button>
      </div>
    ));
    const rest = lines.filter((l) => !outcome.lineIds.includes(l.id));
    actions = (
      <>
        <AccentButton onClick={onRetry} disabled={gone.length > 0 || rest.length === 0} className="h-12">
          Fazer pedido · {money(totalCents)}
        </AccentButton>
        <Link href={menuHref} className={secondary}>
          Voltar para a sacola
        </Link>
      </>
    );
  } else {
    title = "Falta ajustar o pedido";
    body = outcome.message;
    actions = (
      <>
        {outcome.fix === "payment" ? (
          <AccentButton onClick={onPayment} className="h-12">
            Trocar a forma de pagamento
          </AccentButton>
        ) : (
          <Link href={outcome.fix === "address" ? checkoutHref : menuHref} className="flex h-12 items-center justify-center rounded-md bg-(--menu-accent) font-medium text-white no-underline">
            {outcome.fix === "address" ? "Alterar a entrega" : "Voltar para a sacola"}
          </Link>
        )}
        <button type="button" onClick={onClose} className={secondary}>
          Fechar
        </button>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-20">
      <div className="absolute inset-0 bg-[rgba(26,24,20,.5)]" onClick={onClose} aria-hidden />
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="send-error-title"
        className="absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-xl flex-col gap-3.5 rounded-t-2xl bg-surface px-4 pt-5 pb-[18px]"
      >
        <div>
          <h2 id="send-error-title" className="m-0 font-heading text-[20px] leading-tight font-bold">
            {title}
          </h2>
          <div className="mt-1 text-ink-2">{body}</div>
        </div>
        {extra}
        <div className="flex flex-col gap-2">{actions}</div>
      </section>
    </div>
  );
}
