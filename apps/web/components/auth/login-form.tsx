"use client";

import { TRIAL_DAYS } from "@dishdesk/shared";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError, apiRequest } from "@/lib/api";

/** Painel esquerdo do board "Login · Escolha de restaurante". */
export function LoginForm() {
  const { session, login, logout } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);

  const [submit, submitting] = usePendingAction(async () => {
    setError(null);
    try {
      await login(email, password);
      setPassword("");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível entrar. Tente novamente.");
    }
  });

  return (
    <section className="flex w-[520px] shrink-0 flex-col bg-paper px-16 py-14">
      <div className="mb-[72px] flex items-center gap-2.5">
        <LogoMark className="size-[30px]" />
        <span className="font-heading text-[19px] font-bold tracking-[-0.3px]">Dish Desk</span>
      </div>

      <div className="mb-10">
        <h1 className="mb-2 font-heading text-[26px] leading-[1.1] font-bold tracking-[-0.5px]">
          {forgot && !session ? "Redefinir senha" : "Bem-vindo de volta"}
        </h1>
        <p className="text-ink-3">
          {session
            ? `Conectado como ${session.user.name}. Escolha ao lado onde quer atender.`
            : forgot
              ? "Informe o e-mail da sua conta. Enviamos um link para você criar uma senha nova."
              : "Entre com seu e-mail e senha para acessar o painel de atendimento."}
        </p>
      </div>

      {session ? (
        <Button variant="outline" className="h-10 w-full" onClick={() => logout()}>
          Entrar com outra conta
        </Button>
      ) : forgot ? (
        <ForgotPasswordForm email={email} onEmailChange={setEmail} onBack={() => setForgot(false)} />
      ) : (
        <form
          className="flex flex-col gap-[18px]"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-[5px]">
            <Label htmlFor="email" className="text-[11.5px]">
              E-mail
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="h-10"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>

          <div className="flex flex-col gap-[5px]">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password" className="text-[11.5px]">
                Senha
              </Label>
              <button
                type="button"
                className="text-[11.5px] text-ink-3 hover:text-ink-2"
                onClick={() => {
                  setError(null);
                  setForgot(true);
                }}
              >
                Esqueceu?
              </button>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className="h-10"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>

          {error && (
            <p role="alert" className="text-[11px] text-tomate">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="mt-0.5 w-full" loading={submitting}>
            Entrar
          </Button>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-rule" />
            <span className="text-[11px] text-ink-3">ou continue com</span>
            <div className="h-px flex-1 bg-rule" />
          </div>

          {/* Só visual por enquanto: a integração com o Google vem depois. */}
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full gap-[9px]"
            onClick={() => setNotice("O login com Google estará disponível em breve.")}
          >
            <GoogleIcon />
            Continuar com Google
          </Button>

          {notice && <p className="text-[11px] text-ink-3">{notice}</p>}
        </form>
      )}

      <p className="mt-auto pt-8 text-[12px] text-ink-3">
        Não tem acesso? Solicite ao <span className="font-medium text-ink-2">admin do restaurante</span>. Ainda não usa o Dish
        Desk?{" "}
        <Link href="/cadastro" className="font-medium text-ink-2 underline underline-offset-2">
          Teste grátis por {TRIAL_DAYS} dias
        </Link>
        .
      </p>
    </section>
  );
}

/** "Esqueceu?": o link chega pelo e-mail (Supabase Auth) e abre /redefinir-senha. */
function ForgotPasswordForm({ email, onEmailChange, onBack }: { email: string; onEmailChange(email: string): void; onBack(): void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [submit, submitting] = usePendingAction(async () => {
    setError(null);
    try {
      await apiRequest("/auth/forgot-password", { method: "POST", body: { email } });
      setSentTo(email);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível enviar o link. Tente novamente.");
    }
  });

  if (sentTo) {
    return (
      <div className="flex flex-col gap-[18px]">
        <p role="status" className="rounded-lg border border-rule bg-surface px-4 py-3 text-ink-2">
          Se houver uma conta com <span className="font-medium text-ink">{sentTo}</span>, o link chega em alguns minutos.
          Confira também a caixa de spam.
        </p>
        <Button variant="outline" className="h-10 w-full" onClick={onBack}>
          Voltar para o login
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-[18px]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-[5px]">
        <Label htmlFor="forgot-email" className="text-[11.5px]">
          E-mail
        </Label>
        <Input
          id="forgot-email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          className="h-10"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </div>

      {error && (
        <p role="alert" className="text-[11px] text-tomate">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" className="mt-0.5 w-full" loading={submitting}>
        Enviar link
      </Button>
      <Button type="button" variant="ghost" className="h-10 w-full" onClick={onBack}>
        Voltar para o login
      </Button>
    </form>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}
