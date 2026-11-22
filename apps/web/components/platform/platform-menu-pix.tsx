"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformLoading, PlatformPage } from "@/components/platform/platform-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { count } from "@/lib/format";
import { cn } from "@/lib/utils";

type PlatformPix = { tenantId: string; name: string; recipientId: string | null; pixEnabled: boolean };

const RECIPIENT = /^re_[A-Za-z0-9]{6,40}$/;

/**
 * Pix do cardápio por restaurante (F6-01): a equipe liga o recebedor da Pagar.me (a conta que recebe o dinheiro). O
 * restaurante não troca isso pelo painel, para ninguém mudar a conta de destino. Sem board no design: segue Importações.
 */
export function PlatformMenuPix() {
  const { request } = useAuth();
  const list = useQuery({ queryKey: ["platform-menu-pix"], queryFn: () => request<PlatformPix[]>("/platform/menu-pix") });
  const linked = list.data?.filter((t) => t.recipientId).length ?? 0;

  return (
    <PlatformPage title="Pix do cardápio">
      {list.data ? (
        <section className="overflow-hidden rounded-xl border border-rule">
          <div className="border-b border-rule px-5 pt-4 pb-3.5">
            <h2 className="font-heading text-title font-semibold tabular-nums">
              {count(linked)} de {count(list.data.length)} com Pix ligado
            </h2>
            <p className="mt-1 text-ink-2">
              Crie o recebedor na Pagar.me com a conta bancária do restaurante e cole o id (re_…) aqui. Depois o restaurante liga o Pix em Configurações → Pagamentos do cardápio.
            </p>
          </div>
          {list.data.length === 0 ? (
            <p className="px-5 py-6 text-ink-3">Nenhum restaurante com o módulo Cardápio.</p>
          ) : (
            <ul>
              {list.data.map((tenant) => (
                <PixRow key={tenant.tenantId} tenant={tenant} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <PlatformLoading failed={list.isError} />
      )}
    </PlatformPage>
  );
}

function PixRow({ tenant }: { tenant: PlatformPix }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(tenant.recipientId ?? "");
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const valid = RECIPIENT.test(trimmed);

  const save = async (recipientId: string | null) => {
    setError(null);
    try {
      await request(`/platform/menu-pix/${tenant.tenantId}`, { method: "PUT", body: { recipientId } });
      if (!recipientId) setValue("");
      await queryClient.invalidateQueries({ queryKey: ["platform-menu-pix"] });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível salvar.");
    }
  };

  const status = tenant.recipientId ? (tenant.pixEnabled ? "Ligado e aceito na loja" : "Ligado, a loja ainda não aceita") : "Sem recebedor";
  return (
    <li className="flex flex-col gap-2 border-b border-rule-soft px-5 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">{tenant.name}</span>
        <span className={cn("text-[12px] font-semibold", tenant.recipientId ? (tenant.pixEnabled ? "text-success" : "text-warning") : "text-ink-3")}>{status}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="re_xxxxxxxxxxxx"
          aria-label={`Recebedor da Pagar.me de ${tenant.name}`}
          aria-invalid={trimmed !== "" && !valid ? true : undefined}
          className="max-w-xs font-mono"
        />
        <Button onClick={() => save(trimmed)} disabled={!valid || trimmed === tenant.recipientId}>
          Salvar
        </Button>
        {tenant.recipientId && (
          <Button variant="outline" onClick={() => save(null)}>
            Desligar
          </Button>
        )}
      </div>
      {trimmed !== "" && !valid && <p className="m-0 text-[12px] text-tomate">O id do recebedor começa com re_.</p>}
      {error && (
        <p role="alert" className="m-0 text-[12px] text-tomate">
          {error}
        </p>
      )}
    </li>
  );
}
