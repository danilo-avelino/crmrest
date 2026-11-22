"use client";

import { MetaPixel } from "@/components/public-menu/ads-consent";
import { track } from "@/lib/attribution";
import { formatPhone } from "@dishdesk/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { CartProvider, useCart } from "@/lib/public-cart";
import {
  type CheckoutScreen,
  type CheckoutState,
  chooseIdentity,
  chooseMode,
  fetchMe,
  firstMissing,
  loadCheckout,
  logout,
  type Me,
  nextScreen,
  previousScreen,
  saveCheckout,
  toApiPhone,
} from "@/lib/public-checkout";
import type { PublicMenuStore } from "@/lib/public-menu";
import { AddressStep } from "./address-step";
import { FulfillmentStep } from "./fulfillment-step";
import { IdentifyStep } from "./identify-step";
import { AccentButton, CheckoutHeader, Field, inputClass } from "./ui";

const noSubscribe = () => () => {};

/** Checkout do cardápio (F3-07): só no navegador, porque o estado e a sacola vivem no localStorage. */
export function Checkout({ slug, store, scheduleRequested }: { slug: string; store: PublicMenuStore; scheduleRequested: boolean }) {
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  return (
    <CartProvider slug={slug}>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col bg-paper">
        {hydrated ? <CheckoutFlow slug={slug} store={store} scheduleRequested={scheduleRequested} /> : <CheckoutSkeleton />}
        <MetaPixel pixelId={store.metaPixelId} />
      </div>
    </CartProvider>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-label="Carregando" aria-busy>
      <div className="h-8 w-2/3 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-32 animate-pulse rounded-xl bg-surface-2" />
      <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

/** Tela de abertura: a primeira que falta; "pagamento" (voltando do F3-08) reabre a última do passo Entrega. */
function openingScreen(state: CheckoutState): CheckoutScreen {
  const screen = firstMissing(state);
  if (screen !== "payment") return screen;
  return previousScreen("payment", state) ?? "fulfillment";
}

function CheckoutFlow({ slug, store, scheduleRequested }: { slug: string; store: PublicMenuStore; scheduleRequested: boolean }) {
  const router = useRouter();
  const { lines } = useCart();
  const subtotalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const menuHref = `/c/${encodeURIComponent(slug)}`;

  // Funil: entrou no checkout com a sacola (uma vez por abertura da página).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || lines.length === 0) return;
    startedRef.current = true;
    track(slug, "INITIATE_CHECKOUT", { valueCents: subtotalCents });
  }, [slug, lines.length, subtotalCents]);

  const [state, setState] = useState<CheckoutState>(() => loadCheckout(slug));
  // Visitante não consulta a sessão: nunca vê dado salvo (R1).
  const [me, setMe] = useState<Me | null | "checking" | "error">(() => (state.identity?.kind === "guest" ? null : "checking"));
  const [screen, setScreen] = useState<CheckoutScreen | null>(() => (state.identity?.kind === "guest" ? openingScreen(state) : null));
  const [meTry, setMeTry] = useState(0);

  const update = (change: (current: CheckoutState) => CheckoutState) =>
    setState((current) => {
      const next = change(current);
      saveCheckout(slug, next);
      return next;
    });

  useEffect(() => {
    if (me !== "checking") return;
    let alive = true;
    fetchMe(slug)
      .then((found) => {
        if (!alive) return;
        const next: CheckoutState = found
          ? chooseIdentity(state, { kind: "otp", name: found.name ?? (state.identity?.kind === "otp" ? state.identity.name : ""), phone: found.phone })
          : state.identity?.kind === "otp"
            ? chooseIdentity(state, null)
            : state;
        saveCheckout(slug, next);
        setState(next);
        setMe(found);
        setScreen(openingScreen(next));
      })
      .catch(() => alive && setMe("error"));
    return () => {
      alive = false;
    };
    // Só na abertura (e no "Tentar de novo"): o estado de agora é o lido do navegador.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, meTry]);

  if (lines.length === 0) {
    return (
      <>
        <CheckoutHeader title="Finalizar pedido" backHref={menuHref} />
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
          <h2 className="m-0 font-heading text-title font-semibold">Sua sacola está vazia</h2>
          <p className="m-0 text-ink-2">Escolha os itens no cardápio para finalizar o pedido.</p>
          <Link href={menuHref} className="flex h-11 items-center rounded-lg bg-ink px-4 font-medium text-paper no-underline">
            Ver o cardápio
          </Link>
        </div>
      </>
    );
  }

  if (me === "error") {
    return (
      <>
        <CheckoutHeader title="Finalizar pedido" backHref={menuHref} />
        <div role="alert" className="flex flex-col items-center gap-3 px-4 py-16 text-center">
          <p className="m-0 font-medium">Não conseguimos abrir o checkout.</p>
          <Button variant="outline" onClick={() => (setMe("checking"), setMeTry((n) => n + 1))}>
            Tentar de novo
          </Button>
        </div>
      </>
    );
  }
  if (me === "checking" || screen === null) return <CheckoutSkeleton />;

  const go = (from: CheckoutScreen, next: CheckoutState) => {
    const to = nextScreen(from, next);
    if (to === "payment") router.push(`${menuHref}/checkout/pagamento`);
    else setScreen(to);
  };
  const back = (from: CheckoutScreen) => {
    const to = previousScreen(from, state);
    if (to) setScreen(to);
    else router.push(menuHref);
  };

  const identity = state.identity;
  const verified = identity?.kind === "otp" && me != null;

  if (screen === "identify") {
    if (identity?.kind === "otp" && verified && !identity.name.trim()) {
      return <NameForm onBack={() => router.push(menuHref)} onDone={(name) => (update((s) => ({ ...s, identity: { ...identity, name } })), setScreen("fulfillment"))} />;
    }
    return (
      <IdentifyStep
        slug={slug}
        storeName={store.name}
        initialPhone={identity?.phone.replace(/^\+55/, "") ?? ""}
        backHref={menuHref}
        onVerified={async () => {
          const found = await fetchMe(slug).catch(() => null);
          if (!found) return;
          const next = chooseIdentity(state, { kind: "otp", name: found.name ?? "", phone: found.phone });
          update(() => next);
          setMe(found);
          setScreen(found.name ? "fulfillment" : "identify");
        }}
        onGuest={(guest) => {
          const next = chooseIdentity(state, { kind: "guest", name: guest.name, phone: toApiPhone(guest.phone) });
          update(() => next);
          setMe(null);
          setScreen("fulfillment");
        }}
      />
    );
  }

  const identityLine = identity && (
    <div className="flex items-center justify-between gap-2 text-ink-2">
      <span className="min-w-0 truncate">
        {identity.kind === "otp" ? "Pedido de " : "Sem salvar dados · "}
        <span className="font-medium text-ink">{identity.name}</span> · {formatPhone(identity.phone)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          if (identity.kind === "otp") await logout(slug).catch(() => undefined);
          update((s) => chooseIdentity(s, null));
          setMe(null);
          setScreen("identify");
        }}
      >
        {identity.kind === "otp" ? "Sair" : "Trocar"}
      </Button>
    </div>
  );

  if (screen === "fulfillment") {
    return (
      <FulfillmentStep
        slug={slug}
        store={store}
        subtotalCents={subtotalCents}
        mode={state.mode}
        when={state.when}
        scheduleRequested={scheduleRequested}
        identityLine={identityLine}
        onBack={() => back("fulfillment")}
        onContinue={({ mode, when, quote }) => {
          const next = { ...chooseMode(state, mode), when, ...(mode === "PICKUP" ? { quote } : {}) };
          update(() => next);
          go("fulfillment", next);
        }}
      />
    );
  }

  // Endereço (só entrega). Endereços salvos só com a sessão do código.
  return (
    <AddressStep
      slug={slug}
      store={store}
      subtotalCents={subtotalCents}
      saved={verified && me ? me.addresses : []}
      canSave={verified}
      current={state.address}
      onBack={() => back("address")}
      onPickup={() => {
        update((s) => chooseMode(s, "PICKUP"));
        setScreen("fulfillment");
      }}
      onDone={(address, quote) => {
        const next = { ...state, address, quote };
        update(() => next);
        go("address", next);
      }}
    />
  );
}

/** Cadastro sem nome depois do código: o pedido precisa de um nome. */
function NameForm({ onBack, onDone }: { onBack: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <CheckoutHeader title="Identificação" onBack={onBack} />
      <form
        noValidate
        className="flex flex-col gap-4 px-4 py-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) setError("Informe seu nome.");
          else onDone(name.trim());
        }}
      >
        <h2 className="m-0 font-heading text-[24px] leading-tight font-bold tracking-[-0.5px]">Como podemos te chamar?</h2>
        <Field id="me-name" label="Nome" error={error ?? undefined}>
          <input
            id="me-name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "me-name-error" : undefined}
            className={inputClass}
          />
        </Field>
        <AccentButton type="submit">Continuar</AccentButton>
      </form>
    </>
  );
}
