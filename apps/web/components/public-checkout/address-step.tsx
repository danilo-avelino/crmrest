"use client";

import { CHECKOUT_ADDRESS_LABELS, type CheckoutAddressField, type CheckoutAddressInput, validateCheckoutAddress } from "@dishdesk/shared";
import { LocateFixedIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type AddressLabel,
  type CheckoutAddressChoice,
  etaLabel,
  fetchQuote,
  lookupCep,
  maskCep,
  type Quote,
  type QuoteResponse,
  type SavedAddress,
  savedAddressTitle,
  storeContactLink,
} from "@/lib/public-checkout";
import { money, type PublicMenuStore } from "@/lib/public-menu";
import { cn } from "@/lib/utils";
import { AccentButton, CheckoutFooter, CheckoutHeader, ErrorNote, Field, inputClass, RadioDot } from "./ui";

const EMPTY_FORM: CheckoutAddressInput = {
  zipCode: "",
  street: "",
  number: "",
  noNumber: false,
  complement: "",
  district: "",
  city: "",
  state: "",
  reference: "",
};

/** Ordem dos campos no resumo de erros (a da tela). */
const ORDER: CheckoutAddressField[] = ["zipCode", "street", "number", "complement", "district", "city", "state", "reference"];

type Problem = Extract<QuoteResponse, { ok: false }> | { ok: false; code: "NETWORK"; message: string };
const toQuote = (q: Extract<QuoteResponse, { ok: true }>): Quote => ({ feeCents: q.feeCents, eta: q.eta, freeDelivery: q.freeDelivery });

/**
 * Endereço de entrega (W10, R3, R10, R12). Endereços salvos no topo só com a sessão do código (`saved` vazio para o
 * visitante, R1). Novo endereço pelo CEP (ViaCEP no navegador), sem CEP ou pela localização atual (lat/lng vão para a
 * cotação). Validação própria em português, com todos os erros de uma vez (campo + resumo). Sem mapa por enquanto.
 */
export function AddressStep({
  slug,
  store,
  subtotalCents,
  saved,
  canSave,
  current,
  onBack,
  onPickup,
  onDone,
}: {
  slug: string;
  store: Pick<PublicMenuStore, "phone" | "pickupEnabled">;
  subtotalCents: number;
  saved: SavedAddress[];
  /** Só com o código: "Salvar como Casa/Trabalho". */
  canSave: boolean;
  current: CheckoutAddressChoice | null;
  onBack: () => void;
  onPickup: () => void;
  onDone: (address: CheckoutAddressChoice, quote: Quote) => void;
}) {
  const [view, setView] = useState<"list" | "form">(current?.kind === "new" ? "form" : "list");
  const [selected, setSelected] = useState<string | null>(current?.kind === "saved" ? current.id : (saved[0]?.id ?? null));
  const [savedQuotes, setSavedQuotes] = useState<Record<string, QuoteResponse | "error">>({});
  const [cep, setCep] = useState(current?.kind === "new" ? maskCep(current.address.zipCode) : "");
  const [cepError, setCepError] = useState<string | null>(null);
  const [form, setForm] = useState<CheckoutAddressInput>(current?.kind === "new" ? { ...current.address } : EMPTY_FORM);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    current?.kind === "new" && current.lat != null && current.lng != null ? { lat: current.lat, lng: current.lng } : null,
  );
  const [locError, setLocError] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState<AddressLabel | null>(current?.kind === "new" ? current.saveAs : null);
  const [errors, setErrors] = useState<Partial<Record<CheckoutAddressField, string>>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Taxa e prazo de cada endereço salvo, pelo bairro.
  const savedKey = saved.map((a) => a.id).join(",");
  useEffect(() => {
    let alive = true;
    for (const address of saved.slice(0, 5)) {
      fetchQuote(slug, { mode: "DELIVERY", subtotalCents, address: { district: address.district } })
        .then((q) => alive && setSavedQuotes((all) => ({ ...all, [address.id]: q })))
        .catch(() => alive && setSavedQuotes((all) => ({ ...all, [address.id]: "error" })));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, savedKey, subtotalCents]);

  async function quoteFor(district: string, at: { lat: number; lng: number } | null): Promise<QuoteResponse | null> {
    try {
      return await fetchQuote(slug, { mode: "DELIVERY", subtotalCents, address: { district: district.trim() || null, lat: at?.lat ?? null, lng: at?.lng ?? null } });
    } catch {
      setProblem({ ok: false, code: "NETWORK", message: "Não conseguimos calcular a entrega. Tente de novo." });
      return null;
    }
  }

  /** Cotação de prévia (taxa e prazo embaixo do formulário), sem travar nada. */
  async function preview(district: string, at: { lat: number; lng: number } | null) {
    if (!district.trim() && !at) return;
    const q = await quoteFor(district, at);
    if (!q) return;
    setQuote(q.ok ? toQuote(q) : null);
    setProblem(q.ok || q.code === "ADDRESS_REQUIRED" ? null : q);
  }

  function set<K extends keyof CheckoutAddressInput>(key: K, value: CheckoutAddressInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
    if (key === "district") {
      setQuote(null);
      setProblem(null);
    }
  }

  async function searchCep() {
    setCepError(null);
    const result = await lookupCep(cep);
    if (!result.ok) {
      setCepError(result.message);
      return;
    }
    const next = { ...EMPTY_FORM, zipCode: cep, street: result.street, district: result.district, city: result.city, state: result.state };
    setForm(next);
    setErrors({});
    setView("form");
    void preview(next.district, coords);
  }

  function locate() {
    setLocError(null);
    return new Promise<void>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const at = { lat: position.coords.latitude, lng: position.coords.longitude };
          setCoords(at);
          setView("form");
          void preview(form.district, at);
          resolve();
        },
        () => {
          setLocError("Não conseguimos sua localização. Preencha o endereço pelo CEP.");
          resolve();
        },
        { enableHighAccuracy: true, timeout: 15_000 },
      );
    });
  }

  async function submitForm() {
    const result = validateCheckoutAddress({ ...form, zipCode: cep || form.zipCode });
    if (!result.ok) {
      setErrors(result.errors);
      setTimeout(() => summaryRef.current?.focus(), 0);
      return;
    }
    setErrors({});
    const q = await quoteFor(result.address.district, coords);
    if (!q) return;
    if (!q.ok) {
      setQuote(null);
      setProblem(q);
      return;
    }
    onDone({ kind: "new", address: result.address, lat: coords?.lat ?? null, lng: coords?.lng ?? null, saveAs: canSave ? saveAs : null }, toQuote(q));
  }

  const errorFields = ORDER.filter((f) => errors[f]);
  const contact = storeContactLink(store.phone);
  const geolocation = typeof navigator !== "undefined" && "geolocation" in navigator;

  const outOfArea = problem && problem.code !== "NETWORK" && problem.code !== "ADDRESS_REQUIRED" && (
    <div role="alert" className="flex flex-col gap-2.5 rounded-xl border border-[#E8B9B0] bg-tomate-lt p-3">
      <div className="text-[#9C2914]">
        <span className="block font-semibold">{problem.code === "OUT_OF_AREA" ? "Não entregamos nesse endereço." : "A entrega não está disponível."}</span>
        {problem.message}
      </div>
      <div className="flex gap-2">
        {store.pickupEnabled && (
          <button type="button" onClick={onPickup} className="flex h-11 flex-1 items-center justify-center rounded-lg bg-ink font-medium text-paper">
            Retirar na loja
          </button>
        )}
        {contact && (
          <a
            href={contact}
            target="_blank"
            rel="noreferrer"
            className="flex h-11 flex-1 items-center justify-center rounded-lg border border-rule bg-surface font-medium text-ink no-underline"
          >
            Falar com a loja
          </a>
        )}
      </div>
    </div>
  );

  if (view === "list") {
    const choice = saved.find((a) => a.id === selected);
    const choiceQuote = choice ? savedQuotes[choice.id] : undefined;
    return (
      <>
        <CheckoutHeader title="Endereço de entrega" onBack={onBack} right="Passo 1 de 3" />
        <div className="flex flex-col gap-3 px-3 py-4 pb-36">
          {saved.length > 0 && (
            <>
              <h2 className="m-0 font-heading text-title font-semibold">Seus endereços</h2>
              <div role="radiogroup" aria-label="Endereços salvos" className="flex flex-col gap-2">
                {saved.map((address) => {
                  const { label, street, area } = savedAddressTitle(address);
                  const q = savedQuotes[address.id];
                  const on = selected === address.id;
                  return (
                    <button
                      key={address.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setSelected(address.id)}
                      className={cn("flex items-start gap-2.5 rounded-xl bg-surface p-3 text-left", on ? "border-2 border-ink" : "border border-rule")}
                    >
                      <span className="mt-0.5">
                        <RadioDot on={on} />
                      </span>
                      <span className="min-w-0 flex-1">
                        {label && <span className="inline-block rounded-sm bg-surface-2 px-1.5 text-[11px] font-semibold text-ink-2">{label}</span>}
                        <span className={cn("block font-medium", label && "mt-1")}>{street}</span>
                        {area && <span className="block text-ink-3">{area}</span>}
                      </span>
                      <span className="text-right text-[12px] text-ink-2 tabular-nums">
                        {q === undefined ? (
                          <span className="inline-block h-8 w-14 animate-pulse rounded-sm bg-surface-2" aria-label="Calculando entrega" />
                        ) : q === "error" || !q.ok ? (
                          <span className="text-tomate">{q !== "error" && q.code === "OUT_OF_AREA" ? "Fora da área" : "A calcular"}</span>
                        ) : (
                          <>
                            {q.feeCents === 0 ? "Grátis" : money(q.feeCents)}
                            <br />
                            {etaLabel(q.eta)}
                          </>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div className="flex flex-col gap-2.5 rounded-xl border border-rule bg-surface px-3 py-3.5">
            <div className="font-semibold">Novo endereço</div>
            <form
              noValidate
              className="flex flex-col gap-1"
              onSubmit={(event) => {
                event.preventDefault();
              }}
            >
              <label htmlFor="cep" className="font-medium">
                CEP
              </label>
              <div className="flex gap-2">
                <input
                  id="cep"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="00000-000"
                  value={cep}
                  onChange={(e) => {
                    setCep(maskCep(e.target.value));
                    setCepError(null);
                  }}
                  aria-invalid={cepError ? true : undefined}
                  aria-describedby={cepError ? "cep-error" : undefined}
                  className={cn(inputClass, "flex-1")}
                />
                <Button type="submit" className="h-11 px-3.5" onClick={searchCep}>
                  Buscar
                </Button>
              </div>
              {cepError && (
                <div id="cep-error" className="text-[12px] font-medium text-tomate">
                  {cepError}
                </div>
              )}
            </form>
            <button
              type="button"
              className="flex min-h-9 items-center text-left font-medium underline"
              onClick={() => {
                setForm(EMPTY_FORM);
                setCep("");
                setView("form");
              }}
            >
              Não sei meu CEP · preencher o endereço
            </button>
            {geolocation && (
              <Button variant="outline" className="h-11" onClick={locate}>
                <LocateFixedIcon aria-hidden />
                Usar minha localização atual
              </Button>
            )}
            {locError && <div className="text-[12px] font-medium text-tomate">{locError}</div>}
          </div>
        </div>

        <CheckoutFooter
          top={
            choiceQuote && choiceQuote !== "error" && choiceQuote.ok ? (
              <FeeLine quote={toQuote(choiceQuote)} />
            ) : choice && choiceQuote !== undefined ? (
              <p className="m-0 px-4 pt-2.5 text-[12px] text-tomate">
                {choiceQuote !== "error" && !choiceQuote.ok ? choiceQuote.message : "Não conseguimos calcular a entrega."} Escolha outro endereço ou cadastre um novo.
              </p>
            ) : null
          }
        >
          <AccentButton
            disabled={!choice || !choiceQuote || choiceQuote === "error" || !choiceQuote.ok}
            onClick={() => {
              if (!choice || !choiceQuote || choiceQuote === "error" || !choiceQuote.ok) return;
              const { street, area } = savedAddressTitle(choice);
              onDone({ kind: "saved", id: choice.id, title: street, area, district: choice.district }, toQuote(choiceQuote));
            }}
          >
            {saved.length > 0 ? "Continuar" : "Informe o endereço"}
          </AccentButton>
        </CheckoutFooter>
      </>
    );
  }

  return (
    <>
      <CheckoutHeader title="Endereço de entrega" onBack={() => setView("list")} right="Passo 1 de 3" />
      <form
        id="address-form"
        noValidate
        className="flex flex-col gap-3 px-3 py-4 pb-44"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        {errorFields.length > 0 && (
          <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-xl border border-[#E8B9B0] bg-tomate-lt p-3 text-[#9C2914] outline-none">
            <div className="font-semibold">{errorFields.length === 1 ? "Falta 1 campo para continuar" : `Faltam ${errorFields.length} campos para continuar`}</div>
            <ul className="m-0 mt-1 pl-[18px]">
              {errorFields.map((f) => (
                <li key={f}>
                  <a href={`#addr-${f}`} className="text-[#9C2914]">
                    {CHECKOUT_ADDRESS_LABELS[f]}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-xl border border-rule bg-surface px-3 py-3.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{cep ? `CEP ${cep}` : coords ? "Pela sua localização" : "Sem CEP"}</span>
            <button type="button" className="font-medium underline" onClick={() => setView("list")}>
              Trocar
            </button>
          </div>
          {errors.zipCode && <div className="text-[12px] font-medium text-tomate">{errors.zipCode}</div>}
          {coords && <p className="m-0 text-[12px] text-ink-3">Localização recebida. Preencha a rua e o número para o entregador.</p>}

          <Field id="addr-street" label="Rua" error={errors.street}>
            <TextInput id="addr-street" value={form.street} error={errors.street} onChange={(v) => set("street", v)} autoComplete="address-line1" />
          </Field>

          <div className="grid grid-cols-2 gap-2.5">
            <div className="flex flex-col gap-1">
              <label htmlFor="addr-number" className="font-medium">
                Número
              </label>
              <TextInput
                id="addr-number"
                value={form.noNumber ? "" : form.number}
                disabled={form.noNumber}
                error={errors.number}
                inputMode="numeric"
                onChange={(v) => set("number", v)}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 pt-6">
              <input
                type="checkbox"
                checked={form.noNumber}
                onChange={(e) => {
                  set("noNumber", e.target.checked);
                  setErrors((er) => ({ ...er, number: undefined }));
                }}
                className="size-5 accent-ink"
              />
              <span>Sem número</span>
            </label>
          </div>
          {errors.number && (
            <div id="addr-number-error" className="-mt-1.5 text-[12px] font-medium text-tomate">
              {errors.number}
            </div>
          )}

          <Field id="addr-complement" label="Complemento" optional error={errors.complement}>
            <TextInput id="addr-complement" value={form.complement} error={errors.complement} placeholder="Apto, bloco, casa 2" onChange={(v) => set("complement", v)} />
          </Field>

          <Field id="addr-district" label="Bairro" error={errors.district}>
            <TextInput
              id="addr-district"
              value={form.district}
              error={errors.district}
              onChange={(v) => set("district", v)}
              onBlur={() => void preview(form.district, coords)}
            />
          </Field>

          <div className="grid grid-cols-[minmax(0,1fr)_72px] gap-2.5">
            <Field id="addr-city" label="Cidade" error={errors.city}>
              <TextInput id="addr-city" value={form.city} error={errors.city} onChange={(v) => set("city", v)} autoComplete="address-level2" />
            </Field>
            <Field id="addr-state" label="UF" error={errors.state}>
              <TextInput id="addr-state" value={form.state} error={errors.state} maxLength={2} onChange={(v) => set("state", v.toUpperCase())} autoComplete="address-level1" />
            </Field>
          </div>

          <Field id="addr-reference" label="Ponto de referência" optional hint="Ajuda o entregador a achar mais rápido." error={errors.reference}>
            <TextInput
              id="addr-reference"
              value={form.reference}
              error={errors.reference}
              placeholder="Ex.: portão azul, ao lado da padaria"
              onChange={(v) => set("reference", v)}
            />
          </Field>

          {canSave && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={saveAs != null} onChange={(e) => setSaveAs(e.target.checked ? "Casa" : null)} className="size-5 accent-ink" />
                <span>Salvar como</span>
              </label>
              {(["Casa", "Trabalho"] as const).map((label) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={saveAs === label}
                  onClick={() => setSaveAs(label)}
                  className={cn("rounded-sm px-2 py-0.5 text-[12px] font-medium", saveAs === label ? "bg-ink text-paper" : "border border-rule")}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {problem?.code === "ADDRESS_REQUIRED" && (
          <ErrorNote title="Precisamos da sua localização para calcular a entrega.">
            {geolocation ? (
              <button type="button" className="mt-1 font-medium text-[#9C2914] underline" onClick={() => void locate()}>
                Usar minha localização atual
              </button>
            ) : (
              "Fale com a loja para combinar a entrega."
            )}
          </ErrorNote>
        )}
        {problem?.code === "NETWORK" && <ErrorNote title={problem.message} />}
        {outOfArea}
      </form>

      <CheckoutFooter top={quote && !problem ? <FeeLine quote={quote} /> : null}>
        <AccentButton type="submit" form="address-form" disabled={Boolean(outOfArea)} onClick={submitForm}>
          {outOfArea ? "Escolha uma saída acima" : "Continuar"}
        </AccentButton>
      </CheckoutFooter>
    </>
  );
}

function FeeLine({ quote }: { quote: Quote }) {
  return (
    <div className="flex justify-between px-4 pt-2.5 text-ink-2 tabular-nums" role="status">
      <span>
        Entrega <span className="font-semibold text-ink">{quote.feeCents === 0 ? "grátis" : money(quote.feeCents)}</span>
      </span>
      <span>
        chega em <span className="font-semibold text-ink">{etaLabel(quote.eta)}</span>
      </span>
    </div>
  );
}

function TextInput({
  id,
  value,
  error,
  onChange,
  ...props
}: { id: string; value: string; error?: string; onChange: (value: string) => void } & Omit<React.ComponentProps<"input">, "id" | "value" | "onChange">) {
  return (
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      className={cn(inputClass, props.disabled && "bg-paper text-ink-3")}
      {...props}
    />
  );
}
