"use client";

import { BusinessHours, fillMessage, reopeningAt, type TenantSettingsDto, WEEKDAY_LABELS } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { AutomationBubble, Card, CardBody, CardFooter, CardPreview, TEXTAREA } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

// A semana começa na segunda na tela; nos dados, o índice 0 é domingo.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_DAY = { open: "18:00", close: "23:00" };

/** Página "Horário": quando o restaurante atende e o que o cliente recebe fora desse horário. */
export function BusinessHoursTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => request<TenantSettingsDto[]>("/settings") });
  const current = settings.data?.find((item) => item.tenantId === tenant.id);
  return current ? <BusinessHoursForm key={current.tenantId} settings={current} /> : <TabLoading failed={settings.isError} />;
}

function BusinessHoursForm({ settings }: { settings: TenantSettingsDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [hours, setHours] = useState<BusinessHours>(settings.businessHours);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(hours) !== JSON.stringify(settings.businessHours);
  const disabled = !settings.canEdit;

  const setDay = (index: number, day: BusinessHours["days"][number]) =>
    setHours((current) => ({ ...current, days: current.days.map((item, i) => (i === index ? day : item)) }));

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const parsed = BusinessHours.safeParse(hours);
    if (!parsed.success) return setFailure(parsed.error.issues[0]?.message ?? "Confira os horários.");
    try {
      const updated = await request<TenantSettingsDto>(`/settings/${settings.tenantId}/business-hours`, { method: "PUT", body: parsed.data });
      queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) =>
        list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)),
      );
      setHours(updated.businessHours);
      toast("Horário salvo");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  return (
    <Card
      title="Horário de funcionamento"
      description="A IA informa este horário ao cliente e sabe quando não há equipe para atender. Fora dele, quem precisa de uma pessoa recebe a mensagem abaixo e a conversa espera o restaurante abrir. Horário de Brasília."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <CardBody className="flex flex-col gap-5">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={hours.enabled}
              disabled={disabled}
              onChange={(event) => setHours((current) => ({ ...current, enabled: event.target.checked }))}
              className="mt-0.5 size-4 shrink-0 accent-ink"
            />
            <span>
              <span className="block text-[13px] font-medium">Usar o horário de funcionamento</span>
              <span className="mt-0.5 block text-[12px] leading-normal text-ink-3">
                Desligado, a IA não informa o horário e o atendimento nunca conta como fechado.
              </span>
            </span>
          </label>

          <div className="flex flex-col divide-y divide-rule-soft rounded-xl border border-rule-soft">
            {DISPLAY_ORDER.map((index) => {
              const day = hours.days[index] ?? null;
              const overnight = day && day.close <= day.open;
              return (
                <div key={index} className="flex min-h-[48px] items-center gap-3 px-3.5 py-2">
                  <label className="flex w-36 items-center gap-2.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={Boolean(day)}
                      disabled={disabled}
                      onChange={(event) => setDay(index, event.target.checked ? DEFAULT_DAY : null)}
                      className="size-4 accent-ink"
                    />
                    {WEEKDAY_LABELS[index]}
                  </label>
                  {day ? (
                    <>
                      <Input
                        type="time"
                        aria-label={`${WEEKDAY_LABELS[index]}: abre às`}
                        value={day.open}
                        disabled={disabled}
                        onChange={(event) => setDay(index, { ...day, open: event.target.value })}
                        className="h-8 w-28 tabular-nums"
                      />
                      <span className="text-ink-3">às</span>
                      <Input
                        type="time"
                        aria-label={`${WEEKDAY_LABELS[index]}: fecha às`}
                        value={day.close}
                        disabled={disabled}
                        onChange={(event) => setDay(index, { ...day, close: event.target.value })}
                        className="h-8 w-28 tabular-nums"
                      />
                      {overnight && <span className="text-[11px] text-ink-3">fecha no dia seguinte</span>}
                    </>
                  ) : (
                    <span className="text-ink-3 italic">Fechado</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="closed-message">Mensagem fora do horário</Label>
            <textarea
              id="closed-message"
              rows={2}
              maxLength={1000}
              value={hours.closedMessage}
              disabled={disabled}
              onChange={(event) => setHours((current) => ({ ...current, closedMessage: event.target.value }))}
              className={TEXTAREA}
            />
            <p className="text-[11px] text-ink-3">
              {"{retorno}"} vira o dia e a hora em que o atendimento volta, como “hoje às 18:00” ou “amanhã às 11:00”.
            </p>
          </div>
        </CardBody>
        <CardPreview label="Prévia da mensagem">
          <AutomationBubble label="fora do horário" text={fillMessage(hours.closedMessage, { retorno: reopeningAt(hours, new Date()) })} />
        </CardPreview>
        <CardFooter error={failure} note={settings.canEdit ? undefined : "Só o administrador do restaurante altera o horário."}>
          {settings.canEdit && (
            <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
              Salvar
            </Button>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
