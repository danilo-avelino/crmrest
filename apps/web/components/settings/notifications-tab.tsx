"use client";

import { ADMIN_PHONES_MAX, AdminNotifications, formatPhone, type TenantSettingsDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon, PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Card, CardBody, CardFooter, Eyebrow } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

const OPTIONS = [
  {
    key: "misconduct",
    label: "Alerta de má conduta",
    hint: "Na hora em que a IA bloqueia uma resposta ofensiva de um atendente ao cliente (módulo Atendimento com IA).",
  },
  {
    key: "weeklyReport",
    label: "Relatório semanal",
    hint: "Toda segunda às 9h: conversas, chamados e seus motivos, tempo de resposta e avaliações dos últimos 7 dias.",
  },
] as const;

/** Página "Notificações": números do administrador que recebem alertas e relatórios pelo WhatsApp do restaurante. */
export function NotificationsTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => request<TenantSettingsDto[]>("/settings") });
  const current = settings.data?.find((item) => item.tenantId === tenant.id);
  return current ? <NotificationsForm key={current.tenantId} settings={current} /> : <TabLoading failed={settings.isError} />;
}

type Draft = { phones: string[]; misconduct: boolean; weeklyReport: boolean };

const draftOf = (saved: AdminNotifications): Draft => ({ ...saved, phones: saved.phones.map(formatPhone) });

function NotificationsForm({ settings }: { settings: TenantSettingsDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings.adminNotifications));
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings.adminNotifications));
  const disabled = !settings.canEdit;

  const setPhone = (index: number, value: string) =>
    setDraft((current) => ({ ...current, phones: current.phones.map((phone, i) => (i === index ? value : phone)) }));

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const parsed = AdminNotifications.safeParse({ ...draft, phones: draft.phones.filter((phone) => phone.trim()) });
    if (!parsed.success) return setFailure(parsed.error.issues[0]?.message ?? "Confira os números.");
    try {
      const updated = await request<TenantSettingsDto>(`/settings/${settings.tenantId}/admin-notifications`, { method: "PUT", body: parsed.data });
      queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) =>
        list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)),
      );
      setDraft(draftOf(updated.adminNotifications));
      toast("Notificações salvas");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  const sendTest = async () => {
    setFailure(null);
    try {
      const { sent } = await request<{ sent: number }>(`/settings/${settings.tenantId}/admin-notifications/test`, { method: "POST" });
      toast(sent === 1 ? "Relatório enviado para 1 número" : `Relatório enviado para ${sent} números`);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível enviar o relatório.");
    }
  };

  return (
    <Card
      title="Notificações pelo WhatsApp"
      description={
        <>
          O Dish Desk avisa o administrador pelo WhatsApp do próprio restaurante
          {settings.notificationChannel ? (
            <>
              {" "}
              (<span className="font-medium text-ink">{settings.notificationChannel}</span>)
            </>
          ) : null}
          . As mensagens se identificam como do Dish Desk.
        </>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <CardBody className="flex flex-col gap-5">
          {!settings.notificationChannel && (
            <p className="flex items-start gap-[9px] rounded-xl border border-warning-line bg-warning-lt px-[13px] py-[11px] text-[12px] leading-normal text-warning-ink">
              <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                Nenhum WhatsApp conectado: as notificações só saem depois que você conectar um em{" "}
                <Link href="/configuracoes/integracoes" className="font-medium underline">
                  Integrações
                </Link>
                .
              </span>
            </p>
          )}

          <div role="group" aria-labelledby="admin-phones" className="flex flex-col gap-1.5">
            <Eyebrow>
              <span id="admin-phones">Números que recebem</span>
            </Eyebrow>
            {draft.phones.map((phone, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="tel"
                  inputMode="tel"
                  aria-label={`Número ${index + 1}`}
                  placeholder="(11) 98765-4321"
                  value={phone}
                  disabled={disabled}
                  onChange={(event) => setPhone(index, event.target.value)}
                  className="w-56 tabular-nums"
                />
                {!disabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remover o número ${index + 1}`}
                    onClick={() => setDraft((current) => ({ ...current, phones: current.phones.filter((_, i) => i !== index) }))}
                  >
                    <XIcon aria-hidden />
                  </Button>
                )}
              </div>
            ))}
            {draft.phones.length === 0 && <p className="text-ink-3 italic">Nenhum número cadastrado.</p>}
            {!disabled && draft.phones.length < ADMIN_PHONES_MAX && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 self-start px-2 text-tomate hover:bg-tomate-lt hover:text-tomate"
                onClick={() => setDraft((current) => ({ ...current, phones: [...current.phones, ""] }))}
              >
                <PlusIcon aria-hidden />
                Adicionar número
              </Button>
            )}
            <p className="text-[11px] text-ink-3">Com DDD. Números de fora do Brasil começam com + e o código do país.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Eyebrow>O que avisar</Eyebrow>
            <div className="flex flex-col divide-y divide-rule-soft rounded-xl border border-rule-soft">
              {OPTIONS.map((option) => (
                <label key={option.key} className="flex items-start gap-3 px-3.5 py-3">
                  <input
                    type="checkbox"
                    checked={draft[option.key]}
                    disabled={disabled}
                    onChange={(event) => setDraft((current) => ({ ...current, [option.key]: event.target.checked }))}
                    className="mt-0.5 size-4 shrink-0 accent-ink"
                  />
                  <span>
                    <span className="block text-[13px] font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-[12px] leading-normal text-ink-3">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </CardBody>
        <CardFooter error={failure} note={settings.canEdit ? undefined : "Só o administrador do restaurante altera as notificações."}>
          {settings.canEdit && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={dirty || settings.adminNotifications.phones.length === 0 || !settings.notificationChannel}
                title={dirty ? "Salve antes de enviar o teste" : undefined}
                onClick={sendTest}
              >
                Enviar relatório de teste
              </Button>
              <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
                Salvar
              </Button>
            </>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
