"use client";

import { CreateMenuImportRequest, MENU_IMPORT_STATUS_LABEL, type MenuImportRequestDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const EMPTY = { storeName: "", cnpj: "" };

/** Pedidos de importação do iFood do restaurante (o mais recente primeiro). */
export function useImportRequests() {
  const { request } = useAuth();
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ["menu-import-requests", tenantId],
    queryFn: () => request<MenuImportRequestDto[]>(`/menu/${tenantId}/import-requests`),
    enabled: Boolean(tenantId),
  });
}

/**
 * "Importar do iFood": o restaurante não importa sozinho. Abre um pedido com o nome da loja no iFood e o CNPJ, e a
 * equipe do Dish Desk importa. Sem board no design: segue o modal "Adicionar restaurante". Desktop no MVP.
 */
export function IfoodImportRequestButton() {
  const [open, setOpen] = useState(false);
  const requests = useImportRequests();
  const pending = requests.data?.find((r) => r.status === "OPEN");
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={Boolean(pending)} title={pending ? "Já existe um pedido aguardando a equipe" : undefined}>
        Importar do iFood
      </Button>
      <IfoodImportRequestDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Situação do último pedido, colada no topo do cardápio (some quando não há pedido). */
export function IfoodImportRequestStatus() {
  const requests = useImportRequests();
  const last = requests.data?.[0];
  if (!last) return null;
  const tone = last.status === "OPEN" ? "border-warning/30 bg-warning/10 text-warning" : last.status === "DONE" ? "border-success/30 bg-success/10 text-success" : "border-tomate/30 bg-tomate-lt text-tomate";
  return (
    <p role="status" className={cn("rounded-lg border px-3.5 py-2.5 text-[12.5px]", tone)}>
      <span className="font-medium">Importação do iFood ({last.storeName}): {MENU_IMPORT_STATUS_LABEL[last.status]}.</span>
      {last.status === "OPEN" && " A equipe do Dish Desk importa o cardápio e avisa por aqui."}
      {last.note && ` ${last.note}`}
    </p>
  );
}

export function IfoodImportRequestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { request } = useAuth();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const id = useId();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<{ storeName?: string; cnpj?: string; form?: string }>({});
  const [sent, setSent] = useState(false);

  const [send, sending] = usePendingAction(async () => {
    const parsed = CreateMenuImportRequest.safeParse(form);
    if (!parsed.success) {
      const message = (name: string) => parsed.error.issues.find((issue) => issue.path[0] === name)?.message;
      return setErrors({ storeName: message("storeName"), cnpj: message("cnpj") });
    }
    setErrors({});
    try {
      await request(`/menu/${tenantId}/import-requests`, { method: "POST", body: form });
      await queryClient.invalidateQueries({ queryKey: ["menu-import-requests", tenantId] });
      setSent(true);
    } catch (failure) {
      setErrors({ form: failure instanceof ApiError ? failure.message : "Não foi possível enviar o pedido. Tente novamente." });
    }
  });

  const close = (next: boolean) => {
    if (sending) return;
    if (!next) {
      setForm(EMPTY);
      setErrors({});
      setSent(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <div className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="mb-1">Importar cardápio do iFood</DialogTitle>
          <DialogDescription>
            {sent
              ? "Pedido enviado. A equipe do Dish Desk importa o cardápio da sua loja e avisa aqui na página do Cardápio."
              : "A equipe do Dish Desk importa as categorias, os itens, os preços e os tamanhos da sua loja no iFood. Depois é só conferir."}
          </DialogDescription>
        </div>
        {sent ? (
          <div className="px-6 py-[18px]">
            <Button onClick={() => close(false)}>Fechar</Button>
          </div>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-3 px-6 py-[18px]"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <div className="flex flex-col gap-[5px]">
              <Label htmlFor={`${id}-store`}>Nome da loja no iFood</Label>
              <Input
                id={`${id}-store`}
                maxLength={120}
                value={form.storeName}
                aria-invalid={errors.storeName ? true : undefined}
                onChange={(event) => setForm((current) => ({ ...current, storeName: event.target.value }))}
              />
              {errors.storeName && (
                <p role="alert" className="text-[11px] text-tomate">
                  {errors.storeName}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-[5px]">
              <Label htmlFor={`${id}-cnpj`}>CNPJ da loja</Label>
              <Input
                id={`${id}-cnpj`}
                autoComplete="off"
                inputMode="numeric"
                placeholder="00.000.000/0000-00"
                value={form.cnpj}
                aria-invalid={errors.cnpj ? true : undefined}
                onChange={(event) => setForm((current) => ({ ...current, cnpj: event.target.value }))}
              />
              {errors.cnpj && (
                <p role="alert" className="text-[11px] text-tomate">
                  {errors.cnpj}
                </p>
              )}
            </div>
            <p className="text-[11.5px] text-ink-3">A loja precisa estar conectada ao Dish Desk em Configurações → Integrações → iFood.</p>
            {errors.form && (
              <p role="alert" className="flex items-center gap-[5px] text-[11.5px] text-tomate">
                <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
                {errors.form}
              </p>
            )}
            <div className="mt-1 flex gap-2">
              <Button type="submit" loading={sending}>
                Enviar pedido
              </Button>
              <Button type="button" variant="outline" disabled={sending} onClick={() => close(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
