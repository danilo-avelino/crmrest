"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/brand/logo-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError, apiRequest } from "@/lib/api";
import { cn } from "@/lib/utils";

const EXPIRED = "Este link expirou ou já foi usado. Peça um novo na tela de login.";

/**
 * Painel esquerdo de /redefinir-senha, no padrão do login. O Supabase Auth volta do link do e-mail com o token no
 * fragmento do endereço (#access_token=...&type=recovery) ou com o erro (#error_code=otp_expired). Só roda no
 * navegador: a página o carrega sem SSR, porque o fragmento não chega ao servidor.
 */
export function ResetPasswordForm() {
  const [token] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return params.get("type") === "recovery" ? params.get("access_token") : null;
  });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // O token não fica no histórico nem no endereço que a pessoa copiar.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const [submit, submitting] = usePendingAction(async () => {
    setError(null);
    if (password !== confirmation) {
      setError("As senhas não conferem.");
      return;
    }
    try {
      await apiRequest("/auth/reset-password", { method: "POST", body: { accessToken: token, password } });
      setDone(true);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível salvar a senha. Tente novamente.");
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
          {done ? "Senha alterada" : token ? "Crie uma senha nova" : "Link expirado"}
        </h1>
        <p className="text-ink-3">
          {done
            ? "Pronto. Por segurança, encerramos as sessões abertas: entre de novo com a senha nova."
            : token
              ? "Use pelo menos 8 caracteres. Depois de salvar, você entra com a senha nova."
              : EXPIRED}
        </p>
      </div>

      {done || !token ? (
        <Link href="/login" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
          {done ? "Entrar" : "Voltar para o login"}
        </Link>
      ) : (
        <form
          className="flex flex-col gap-[18px]"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-[5px]">
            <Label htmlFor="new-password" className="text-[11.5px]">
              Senha nova
            </Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              className="h-10"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>

          <div className="flex flex-col gap-[5px]">
            <Label htmlFor="confirm-password" className="text-[11.5px]">
              Repita a senha
            </Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              className="h-10"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>

          {error && (
            <p role="alert" className="text-[11px] text-tomate">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="mt-0.5 w-full" loading={submitting}>
            Salvar senha nova
          </Button>
        </form>
      )}
    </section>
  );
}
