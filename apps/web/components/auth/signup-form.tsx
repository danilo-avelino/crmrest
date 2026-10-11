"use client";

import { SignupRequest, TRIAL_DAYS } from "@dishdesk/shared";
import Link from "next/link";
import { type ComponentProps, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

const EMPTY = { restaurantName: "", name: "", phone: "", taxId: "", email: "", password: "" };
type Field = keyof typeof EMPTY;

/**
 * Cadastro pelo site (teste grátis). O design ainda não tem este board: segue o painel esquerdo do board
 * "Login · Escolha de restaurante". Desktop no MVP.
 */
export function SignupForm() {
  const { signup } = useAuth();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field | "form", string>>>({});

  const [submit, submitting] = usePendingAction(async () => {
    const parsed = SignupRequest.safeParse(form);
    if (!parsed.success) {
      const message = (name: Field) => parsed.error.issues.find((issue) => issue.path[0] === name)?.message;
      return setErrors(Object.fromEntries((Object.keys(EMPTY) as Field[]).map((name) => [name, message(name)])));
    }
    setErrors({});
    try {
      await signup(parsed.data);
    } catch (failure) {
      setErrors({ form: failure instanceof ApiError ? failure.message : "Não foi possível criar a conta. Tente novamente." });
    }
  });

  const field = (name: Field, label: string, props: ComponentProps<typeof Input> = {}) => (
    <div className="flex flex-col gap-[5px]">
      <Label htmlFor={name} className="text-[11.5px]">
        {label}
      </Label>
      <Input
        id={name}
        required
        className="h-10"
        value={form[name]}
        onChange={(event) => setForm((current) => ({ ...current, [name]: event.target.value }))}
        aria-invalid={errors[name] ? true : undefined}
        {...props}
      />
      {errors[name] && (
        <p role="alert" className="text-[11px] text-tomate">
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <section className="flex w-[520px] shrink-0 flex-col overflow-y-auto bg-paper px-16 py-14">
      <div className="mb-10 flex items-center gap-2.5">
        <LogoMark className="size-[30px]" />
        <span className="font-heading text-[19px] font-bold tracking-[-0.3px]">Dish Desk</span>
      </div>

      <div className="mb-8">
        <h1 className="mb-2 font-heading text-[26px] leading-[1.1] font-bold tracking-[-0.5px]">Teste grátis por {TRIAL_DAYS} dias</h1>
        <p className="text-ink-3">Crie a conta do seu restaurante e comece a atender agora. Não pedimos cartão para começar.</p>
      </div>

      <form
        noValidate
        className="flex flex-col gap-[18px]"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {field("restaurantName", "Nome do restaurante", { maxLength: 80, autoComplete: "organization" })}
        {field("name", "Seu nome", { maxLength: 80, autoComplete: "name" })}
        <div className="grid grid-cols-2 gap-2.5">
          {field("phone", "WhatsApp", { type: "tel", autoComplete: "tel", placeholder: "(86) 99999-9999" })}
          {field("taxId", "CPF ou CNPJ", { autoComplete: "off", placeholder: "Para a nota fiscal" })}
        </div>
        {field("email", "E-mail", { type: "email", autoComplete: "email" })}
        {field("password", "Senha", { type: "password", maxLength: 128, autoComplete: "new-password", placeholder: "Pelo menos 8 caracteres" })}

        {errors.form && (
          <p role="alert" className="text-[11px] text-tomate">
            {errors.form}
          </p>
        )}

        <Button type="submit" size="lg" className="mt-0.5 w-full" loading={submitting}>
          Criar conta e começar o teste
        </Button>

        <p className="text-[11px] text-ink-3">
          Ao criar a conta, você concorda com a{" "}
          <a href="/privacidade" target="_blank" rel="noreferrer" className="font-medium text-ink-2 underline underline-offset-2">
            Política de privacidade
          </a>
          .
        </p>
      </form>

      <p className="mt-auto pt-8 text-[12px] text-ink-3">
        Já tem conta?{" "}
        <Link href="/login" className="font-medium text-ink-2 underline underline-offset-2">
          Entrar
        </Link>
      </p>
    </section>
  );
}
