"use client";

import { BusinessHours, fillMessage, MAX_SHIFTS_PER_DAY, reopeningAt, type TenantSettingsDto, WEEKDAY_LABELS } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
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
const DEFAULT_DAY = [{ open: "18:00", close: "23:00" }];

type Shift = BusinessHours["days"][number][number];

const clockOf = (minutes: number) => {
  const total = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

/** O horário novo começa 1 hora depois do último fechar e dura 4 horas; o restaurante ajusta. */
function nextShift(last: Shift): Shift {
  const open = minutesOf(last.close) + 60;
  return { open: clockOf(open), close: clockOf(open + 240) };
}

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
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const day = issue?.path[0] === "days" && typeof issue.path[1] === "number" ? `${WEEKDAY_LABELS[issue.path[1]]}: ` : "";
      return setFailure(issue ? day + issue.message : "Confira os horários.");
    }
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
              const day = hours.days[index] ?? [];
              const label = WEEKDAY_LABELS[index];
              const setShift = (position: number, shift: Shift) => setDay(index, day.map((item, i) => (i === position ? shift : item)));
              return (
                <div key={index} className="flex min-h-[48px] items-start gap-3 px-3.5 py-2">
                  <label className="flex h-8 w-36 shrink-0 items-center gap-2.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={day.length > 0}
                      disabled={disabled}
                      onChange={(event) => setDay(index, event.target.checked ? DEFAULT_DAY : [])}
                      className="size-4 accent-ink"
                    />
                    {label}
                  </label>
                  {day.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {day.map((shift, position) => {
                        const suffix = position === 0 ? "" : ` (${position + 1}º horário)`;
                        return (
                          <div key={position} className="flex h-8 items-center gap-3">
                            <Input
                              type="time"
                              aria-label={`${label}: abre às${suffix}`}
                              value={shift.open}
                              disabled={disabled}
                              onChange={(event) => setShift(position, { ...shift, open: event.target.value })}
                              className="h-8 w-28 tabular-nums"
                            />
                            <span className="text-ink-3">às</span>
                            <Input
                              type="time"
                              aria-label={`${label}: fecha às${suffix}`}
                              value={shift.close}
                              disabled={disabled}
                              onChange={(event) => setShift(position, { ...shift, close: event.target.value })}
                              className="h-8 w-28 tabular-nums"
                            />
                            {position > 0 && !disabled && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remover o ${position + 1}º horário de ${label}`}
                                onClick={() => setDay(index, day.filter((_, i) => i !== position))}
                              >
                                <XIcon />
                              </Button>
                            )}
                            {shift.close <= shift.open && <span className="text-[11px] text-ink-3">fecha no dia seguinte</span>}
                          </div>
                        );
                      })}
                      {day.length < MAX_SHIFTS_PER_DAY && !disabled && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="self-start text-ink-2"
                          onClick={() => setDay(index, [...day, nextShift(day[day.length - 1]!)])}
                        >
                          <PlusIcon />
                          Adicionar horário
                        </Button>
                      )}
                    </div>
                  ) : (
                    <span className="flex h-8 items-center text-ink-3 italic">Fechado</span>
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
