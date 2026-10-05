"use client";

import {
  ORDER_LINKS_MAX,
  type OrderLink,
  orderLinksMessage,
  type TenantSettingsDto,
  UpdateOrderLinksRequest,
} from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Fragment, useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

// O que a opção 2 responde quando não há links (o mesmo texto do menu de atendimento).
const HANDOFF = "Certo! Um atendente já vai falar com você.";

/** Aba "Links de pedido" do restaurante escolhido. */
export function OrderLinksTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => request<TenantSettingsDto[]>("/settings") });
  const current = settings.data?.find((item) => item.tenantId === tenant.id);
  // A chave remonta o formulário ao trocar de restaurante no painel master.
  return current ? <OrderLinksSection key={current.tenantId} settings={current} /> : <TabLoading failed={settings.isError} />;
}

/** Links enviados quando o cliente escolhe "2 - Fazer um pedido" no menu de atendimento. */
function OrderLinksSection({ settings }: { settings: TenantSettingsDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  // O admin sem links já começa com uma linha em branco para preencher. No máximo 5 linhas: a posição serve de chave.
  const [rows, setRows] = useState<OrderLink[]>(() =>
    settings.orderLinks.length || !settings.canEdit ? settings.orderLinks : [{ label: "", url: "" }],
  );
  /** Erro de validação por linha (posição em `rows`). */
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  // Linhas totalmente em branco são ignoradas.
  const filled = rows
    .map((row, index) => ({ index, label: row.label.trim(), url: row.url.trim() }))
    .filter((row) => row.label || row.url);
  const links = filled.map(({ label, url }) => ({ label, url }));
  const dirty = JSON.stringify(links) !== JSON.stringify(settings.orderLinks);

  const change = (index: number, field: keyof OrderLink, value: string) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([i]) => Number(i) !== index)));
  };
  const remove = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
    setErrors({});
  };

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const parsed = UpdateOrderLinksRequest.safeParse({ orderLinks: links });
    if (!parsed.success) {
      const next: Record<number, string> = {};
      for (const issue of parsed.error.issues) {
        const row = typeof issue.path[1] === "number" ? filled[issue.path[1]] : undefined;
        if (row) next[row.index] ??= issue.message;
        else setFailure(issue.message);
      }
      setErrors(next);
      return;
    }
    try {
      const updated = await request<TenantSettingsDto>(`/settings/${settings.tenantId}/order-links`, { method: "PUT", body: parsed.data });
      queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) =>
        list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)),
      );
      setRows(updated.orderLinks);
      toast("Links salvos");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Links para fazer pedido</h2>
        <p className="mt-1 text-ink-2">
          Enviados automaticamente quando o cliente escolhe <span className="font-medium text-ink">2 - Fazer um pedido</span> no
          menu do WhatsApp e do Instagram. Sem links, a opção chama um atendente.
        </p>
      </div>

      <form
        noValidate
        className="flex flex-col gap-3 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {rows.length > 0 ? (
          <div className="grid grid-cols-[180px_minmax(0,1fr)_36px] items-center gap-x-2 gap-y-2">
            <Label htmlFor={`${id}-label-0`}>Nome</Label>
            <Label htmlFor={`${id}-url-0`}>Endereço</Label>
            <span />
            {rows.map((row, index) => (
              <Fragment key={index}>
                <Input
                  id={`${id}-label-${index}`}
                  aria-label={`Nome do link ${index + 1}`}
                  value={row.label}
                  maxLength={40}
                  placeholder="Cardápio digital"
                  disabled={!settings.canEdit}
                  aria-invalid={Boolean(errors[index]) || undefined}
                  onChange={(event) => change(index, "label", event.target.value)}
                />
                <Input
                  id={`${id}-url-${index}`}
                  aria-label={`Endereço do link ${index + 1}`}
                  type="url"
                  inputMode="url"
                  value={row.url}
                  placeholder="https://"
                  disabled={!settings.canEdit}
                  aria-invalid={Boolean(errors[index]) || undefined}
                  onChange={(event) => change(index, "url", event.target.value)}
                />
                {settings.canEdit ? (
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remover o link ${index + 1}`} onClick={() => remove(index)}>
                    <Trash2Icon aria-hidden />
                  </Button>
                ) : (
                  <span />
                )}
                {errors[index] && (
                  <p role="alert" className="col-span-3 -mt-1 text-[11px] text-tomate">
                    {errors[index]}
                  </p>
                )}
              </Fragment>
            ))}
          </div>
        ) : (
          <p className="text-ink-3 italic">Nenhum link cadastrado.</p>
        )}

        {settings.canEdit ? (
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rows.length >= ORDER_LINKS_MAX}
              title={rows.length >= ORDER_LINKS_MAX ? `No máximo ${ORDER_LINKS_MAX} links` : undefined}
              onClick={() => setRows((current) => [...current, { label: "", url: "" }])}
            >
              <PlusIcon aria-hidden />
              Adicionar link
            </Button>
            <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
              Salvar
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-ink-3">Só o administrador do restaurante altera os links.</p>
        )}
        {failure && (
          <p role="alert" className="text-[11px] text-tomate">
            {failure}
          </p>
        )}
      </form>

      <div className="border-t border-rule bg-paper px-5 py-4">
        <div className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Prévia da mensagem</div>
        <div className="max-w-[440px] rounded-[10px] border border-warning-line bg-warning-lt px-3.5 py-2.5">
          <div className="mb-1 flex items-center gap-[5px] text-[10.5px] font-semibold text-warning-ink">
            <SparklesIcon className="size-3" aria-hidden />
            {links.length ? "Automação · links para pedir" : "Automação · encaminhado à equipe"}
          </div>
          <div className="leading-[1.45] break-words whitespace-pre-wrap">{links.length ? orderLinksMessage(links) : HANDOFF}</div>
        </div>
      </div>
    </section>
  );
}
