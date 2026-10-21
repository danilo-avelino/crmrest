"use client";

import { AddTenantRequest, type AddTenantResponse, BILLING_PLANS } from "@dishdesk/shared";
import { AlertCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError, apiRequest } from "@/lib/api";
import { currencyWhole } from "@/lib/format";

const EMPTY = { name: "", taxId: "", test: false };

/**
 * "Adicionar restaurante" da escolha de restaurante. O design ainda não tem este modal: segue os modais do board
 * Clientes → LGPD. O restaurante novo não tem teste grátis e vai direto para a escolha do plano; o de teste (sem
 * cobrança), que só o super admin cria, já abre. Desktop no MVP.
 */
export function AddTenantDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session, reload, selectContext } = useAuth();
  const router = useRouter();
  const id = useId();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<{ name?: string; taxId?: string; form?: string }>({});

  const [save, saving] = usePendingAction(async () => {
    const parsed = AddTenantRequest.safeParse({ name: form.name, taxId: form.test ? undefined : form.taxId, test: form.test });
    if (!parsed.success) {
      const message = (name: string) => parsed.error.issues.find((issue) => issue.path[0] === name)?.message;
      return setErrors({ name: message("name"), taxId: message("taxId") });
    }
    setErrors({});
    try {
      const { tenantId } = await apiRequest<AddTenantResponse>("/auth/tenants", { method: "POST", body: parsed.data });
      await reload();
      if (parsed.data.test) await selectContext({ mode: "tenant", tenantId });
      else router.push(`/assinatura?restaurante=${tenantId}`);
    } catch (failure) {
      setErrors({ form: failure instanceof ApiError ? failure.message : "Não foi possível adicionar o restaurante. Tente novamente." });
    }
  });

  const close = (next: boolean) => {
    if (saving) return;
    if (!next) {
      setForm(EMPTY);
      setErrors({});
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <div className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="mb-1">Adicionar restaurante</DialogTitle>
          <DialogDescription>
            {form.test
              ? "Restaurante de teste: sem cobrança e sem bloqueio. A criação fica na auditoria da plataforma."
              : `Você será o administrador. Em seguida, escolha o plano: ${currencyWhole(BILLING_PLANS.monthly.amountCents / 100)} por mês ou ${currencyWhole(BILLING_PLANS.annual.amountCents / 100)} por ano.`}
          </DialogDescription>
        </div>
        <form
          noValidate
          className="flex flex-col gap-3 px-6 py-[18px]"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="flex flex-col gap-[5px]">
            <Label htmlFor={`${id}-name`}>Nome do restaurante</Label>
            <Input
              id={`${id}-name`}
              maxLength={80}
              value={form.name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
            {errors.name && (
              <p role="alert" className="text-[11px] text-tomate">
                {errors.name}
              </p>
            )}
          </div>
          {!form.test && (
            <div className="flex flex-col gap-[5px]">
              <Label htmlFor={`${id}-taxId`}>CPF ou CNPJ</Label>
              <Input
                id={`${id}-taxId`}
                autoComplete="off"
                placeholder="Para a nota fiscal"
                value={form.taxId}
                aria-invalid={errors.taxId ? true : undefined}
                onChange={(event) => setForm((current) => ({ ...current, taxId: event.target.value }))}
              />
              {errors.taxId && (
                <p role="alert" className="text-[11px] text-tomate">
                  {errors.taxId}
                </p>
              )}
            </div>
          )}
          {session?.user.isSuperAdmin && (
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-ink"
                checked={form.test}
                onChange={(event) => setForm((current) => ({ ...current, test: event.target.checked }))}
              />
              <span>
                <span className="block text-[13px] font-medium">Restaurante de teste</span>
                <span className="text-[11px] text-ink-3">Sem cobrança. Só a equipe da plataforma vê esta opção.</span>
              </span>
            </label>
          )}
          {errors.form && (
            <p role="alert" className="flex items-center gap-[5px] text-[11.5px] text-tomate">
              <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
              {errors.form}
            </p>
          )}
          <div className="mt-1 flex gap-2">
            <Button type="submit" loading={saving}>
              {form.test ? "Criar restaurante" : "Continuar para o pagamento"}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
