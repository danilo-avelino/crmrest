"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isMobilePhone, maskPhone, OTP_MAX_ATTEMPTS, requestOtp, verifyOtp } from "@/lib/public-checkout";
import { cn } from "@/lib/utils";
import { AccentButton, CheckoutHeader, clock, ErrorNote, Field, inputClass, useNow } from "./ui";

type Phase = "phone" | "code" | "guest";
type SendProblem = { kind: "unavailable" } | { kind: "message"; text: string } | null;

const PHONE_ERROR = "Informe um celular com DDD, como (11) 98765-4321.";

/**
 * Identificação (W8, R1): celular, código de 6 dígitos pelo WhatsApp e a saída "Continuar sem salvar meus dados".
 * O visitante informa nome e celular sem código e não vê nada salvo. A API não diz quantas tentativas restam:
 * a tela conta as erradas do código atual (5 por código, como na API).
 */
export function IdentifyStep({
  slug,
  storeName,
  initialPhone,
  backHref,
  onVerified,
  onGuest,
}: {
  slug: string;
  storeName: string;
  initialPhone: string;
  backHref: string;
  /** Código certo: a sessão está no cookie; quem chama lê GET /me. */
  onVerified: (phone: string) => Promise<void>;
  onGuest: (guest: { name: string; phone: string }) => void;
}) {
  const [phase, setPhase] = useState<Phase>("phone");
  const [phone, setPhone] = useState(maskPhone(initialPhone));
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [optIn, setOptIn] = useState(false);
  const [problem, setProblem] = useState<SendProblem>(null);
  const [resendAt, setResendAt] = useState(0);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [wrong, setWrong] = useState(0);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestErrors, setGuestErrors] = useState<{ name?: string; phone?: string }>({});
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const now = useNow();

  const waitSeconds = Math.max(0, (resendAt - now) / 1000);
  const locked = wrong >= OTP_MAX_ATTEMPTS;
  const code = digits.join("");

  async function send() {
    if (!isMobilePhone(phone)) {
      setPhoneError(PHONE_ERROR);
      return;
    }
    setPhoneError(null);
    setProblem(null);
    const outcome = await requestOtp(slug, phone);
    if (outcome.kind === "sent" || (outcome.kind === "wait" && outcome.retryAfterSeconds != null)) {
      // "wait" com prazo: um código já foi enviado há pouco e continua valendo.
      setResendAt(Date.now() + (outcome.kind === "sent" ? outcome.resendInSeconds : outcome.retryAfterSeconds!) * 1000);
      setDigits(Array(6).fill(""));
      setWrong(0);
      setCodeError(null);
      setHelp(false);
      setPhase("code");
      setTimeout(() => inputs.current[0]?.focus(), 0);
    } else if (outcome.kind === "unavailable") setProblem({ kind: "unavailable" });
    else setProblem({ kind: "message", text: outcome.message });
  }

  async function confirm() {
    setCodeError(null);
    const outcome = await verifyOtp(slug, { phone, code, marketingOptIn: optIn });
    if (outcome.kind === "ok") return onVerified(phone);
    setDigits(Array(6).fill(""));
    if (outcome.kind === "wrong") setWrong((n) => n + 1);
    else setCodeError(outcome.message);
    setTimeout(() => inputs.current[0]?.focus(), 0);
  }

  function typeDigit(index: number, value: string) {
    const typed = value.replace(/\D/g, "");
    const next = [...digits];
    if (typed.length === 0) next[index] = "";
    // Colou ou o celular preencheu o código inteiro: distribui a partir da casa.
    for (let i = 0; i < typed.length && index + i < 6; i++) next[index + i] = typed[i]!;
    setDigits(next);
    const focus = Math.min(5, index + Math.max(typed.length, 0));
    if (typed.length > 0) inputs.current[focus]?.focus();
  }

  function continueAsGuest() {
    const errors: { name?: string; phone?: string } = {};
    if (!guestName.trim()) errors.name = "Informe seu nome.";
    if (!isMobilePhone(phone)) errors.phone = PHONE_ERROR;
    setGuestErrors(errors);
    if (Object.keys(errors).length === 0) onGuest({ name: guestName.trim(), phone });
  }

  const guestLink = (
    <button
      type="button"
      onClick={() => {
        setPhase("guest");
        setProblem(null);
      }}
      className="flex h-12 items-center justify-center rounded-lg border border-rule bg-surface font-medium hover:bg-surface-2"
    >
      Continuar sem salvar meus dados
    </button>
  );

  if (phase === "guest") {
    return (
      <>
        <CheckoutHeader title="Seus dados" onBack={() => setPhase("phone")} />
        <form
          noValidate
          className="flex flex-col gap-4 px-4 py-6"
          onSubmit={(event) => {
            event.preventDefault();
            continueAsGuest();
          }}
        >
          <div>
            <h2 className="m-0 font-heading text-[24px] leading-tight font-bold tracking-[-0.5px]">Para quem é o pedido?</h2>
            <p className="m-0 mt-1 text-ink-2">Sem salvar, você informa o endereço agora e ele não fica guardado para o próximo pedido.</p>
          </div>
          <Field id="guest-name" label="Nome" error={guestErrors.name}>
            <input
              id="guest-name"
              autoComplete="name"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              aria-invalid={guestErrors.name ? true : undefined}
              aria-describedby={guestErrors.name ? "guest-name-error" : undefined}
              className={inputClass}
            />
          </Field>
          <Field id="guest-phone" label="Celular com DDD" hint="A loja usa para falar com você sobre este pedido." error={guestErrors.phone}>
            <input
              id="guest-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              value={phone}
              onChange={(e) => setPhone(maskPhone(e.target.value))}
              aria-invalid={guestErrors.phone ? true : undefined}
              aria-describedby={guestErrors.phone ? "guest-phone-error" : "guest-phone-hint"}
              className={cn(inputClass, "h-12 text-[16px] font-medium")}
            />
          </Field>
          <AccentButton type="submit">Continuar</AccentButton>
        </form>
      </>
    );
  }

  if (phase === "code") {
    return (
      <>
        <CheckoutHeader title="Identificação" onBack={() => setPhase("phone")} right="Passo 2 de 2" />
        <div className="flex flex-col gap-4 px-4 py-6">
          <div>
            <h2 className="m-0 font-heading text-[24px] leading-tight font-bold tracking-[-0.5px]">Digite o código</h2>
            <p className="m-0 mt-1 text-ink-2">
              Mandamos 6 números pelo WhatsApp para <span className="font-semibold text-ink">{phone}</span>.
            </p>
          </div>

          <fieldset className="m-0 border-0 p-0">
            <legend className="sr-only">Código de 6 dígitos</legend>
            <div className={cn("grid grid-cols-6 gap-2", locked && "opacity-50")}>
              {digits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    inputs.current[i] = el;
                  }}
                  aria-label={`Dígito ${i + 1}`}
                  inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  maxLength={i === 0 ? 6 : 1}
                  disabled={locked}
                  value={digit}
                  onChange={(e) => typeDigit(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Backspace" && !digit && i > 0) inputs.current[i - 1]?.focus();
                  }}
                  aria-invalid={wrong > 0 && !locked ? true : undefined}
                  className={cn(
                    "h-[52px] w-full min-w-0 rounded-lg border bg-surface text-center text-[20px] font-semibold text-ink outline-none focus:border-ink focus:shadow-[0_0_0_3px_rgba(26,24,20,.08)]",
                    wrong > 0 && !locked ? "border-tomate" : digit ? "border-ink" : "border-rule",
                  )}
                />
              ))}
            </div>
          </fieldset>

          {wrong > 0 && !locked && (
            <div role="alert" className="font-medium text-tomate">
              Código errado. {OTP_MAX_ATTEMPTS - wrong === 1 ? "Resta 1 tentativa." : `Restam ${OTP_MAX_ATTEMPTS - wrong} tentativas.`}
            </div>
          )}
          {locked && (
            <div role="alert" className="rounded-lg border border-[#F1DFB4] bg-[#FEF9EC] p-2.5 text-[#7A5008]">
              <div className="font-semibold">Muitas tentativas.</div>
              {waitSeconds > 0 ? (
                <>
                  Por segurança, espere <span className="font-semibold tabular-nums">{clock(waitSeconds)}</span> para pedir um novo código.
                </>
              ) : (
                "Por segurança, este código não vale mais. Peça um novo código."
              )}
            </div>
          )}
          {codeError && <ErrorNote title={codeError} />}

          <AccentButton disabled={locked || code.length < 6} onClick={confirm}>
            Confirmar
          </AccentButton>

          <div className="flex flex-col gap-0.5">
            <div className="flex min-h-11 items-center justify-between">
              {waitSeconds > 0 ? (
                <span className="text-ink-3 tabular-nums">{locked ? "Reenviar bloqueado" : `Reenviar em ${clock(waitSeconds)}`}</span>
              ) : (
                <Button variant="link" className="h-11 px-0 text-[13px] text-ink underline" onClick={send}>
                  Reenviar código
                </Button>
              )}
              <button type="button" className="min-h-11 font-medium underline" onClick={() => setPhase("phone")}>
                Trocar número
              </button>
            </div>
            <button type="button" className="flex min-h-11 items-center font-medium underline" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
              Não recebi o código
            </button>
            {help && (
              <div className="flex flex-col gap-3 rounded-lg border border-rule bg-paper p-3 text-ink-2">
                <p className="m-0">
                  Confira se o número {phone} está certo e se o WhatsApp dele está ativo. O código chega pelo WhatsApp do {storeName} e pode levar
                  alguns segundos. {waitSeconds > 0 ? `Você pode pedir outro em ${clock(waitSeconds)}.` : "Você já pode pedir outro."}
                </p>
                {guestLink}
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <CheckoutHeader title="Identificação" backHref={backHref} right="Passo 1 de 2" />
      <form
        noValidate
        className="flex flex-col gap-4 px-4 py-6"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div>
          <h2 className="m-0 font-heading text-[24px] leading-tight font-bold tracking-[-0.5px]">Qual é o seu celular?</h2>
          <p className="m-0 mt-1 text-ink-2">Enviamos um código pelo WhatsApp para confirmar que o número é seu. Assim seus endereços e pedidos ficam salvos.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tel" className="font-medium">
            Celular com DDD
          </label>
          <div className="flex gap-2">
            <span className="flex h-12 items-center rounded-lg border border-rule bg-paper px-3 text-ink-2">+55</span>
            <input
              id="tel"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="(11) 98765-4321"
              value={phone}
              onChange={(e) => setPhone(maskPhone(e.target.value))}
              aria-invalid={phoneError || problem ? true : undefined}
              aria-describedby={phoneError ? "tel-error" : undefined}
              className={cn(inputClass, "h-12 flex-1 text-[16px] font-medium")}
            />
          </div>
          {phoneError && (
            <div id="tel-error" className="text-[12px] font-medium text-tomate">
              {phoneError}
            </div>
          )}
          {problem?.kind === "unavailable" && (
            <ErrorNote title="Não conseguimos enviar o código.">
              Tente de novo em instantes ou continue sem salvar seus dados.
            </ErrorNote>
          )}
          {problem?.kind === "message" && <ErrorNote title={problem.text} />}
        </div>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="mt-0.5 size-5 flex-none accent-ink" />
          <span className="text-ink-2">Quero receber promoções do {storeName} pelo WhatsApp. Dá para sair quando quiser.</span>
        </label>

        <AccentButton type="submit" onClick={send}>
          {problem ? "Tentar de novo" : "Enviar código pelo WhatsApp"}
        </AccentButton>

        <div className="flex items-center gap-2.5 text-[12px] text-ink-3">
          <span className="h-px flex-1 bg-rule" />
          ou
          <span className="h-px flex-1 bg-rule" />
        </div>

        {guestLink}
        <p className="m-0 text-center text-[12px] text-ink-3">Sem salvar, você informa o endereço agora e ele não fica guardado para o próximo pedido.</p>
        <p className="m-0 pt-4 text-center text-[11px] text-ink-3">
          Usamos seu número só para este pedido e para o que você autorizar.{" "}
          <a href="/privacidade" className="underline">
            Privacidade
          </a>
        </p>
      </form>
    </>
  );
}
