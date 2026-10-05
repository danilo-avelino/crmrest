"use client";

import { BusinessHours, type TenantSettingsDto, WEEKDAY_LABELS } from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

// A semana começa na segunda na tela; nos dados, o índice 0 é domingo.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_DAY = { open: "18:00", close: "23:00" };

/** Aba "Horário": quando o restaurante atende e o que o cliente recebe fora desse horário. */
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
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Horário de funcionamento</h2>
        <p className="mt-1 text-ink-2">
          Fora deste horário, quem começa um atendimento no WhatsApp ou no Instagram recebe a mensagem abaixo no lugar do menu.
          Horário de Brasília.
        </p>
      </div>

      <form
        noValidate
        className="flex flex-col gap-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={hours.enabled}
            disabled={disabled}
            onChange={(event) => setHours((current) => ({ ...current, enabled: event.target.checked }))}
            className="size-4 accent-ink"
          />
          Enviar a mensagem fora do horário
        </label>

        <div className="flex flex-col divide-y divide-rule-soft rounded-lg border border-rule-soft">
          {DISPLAY_ORDER.map((index) => {
            const day = hours.days[index] ?? null;
            const overnight = day && day.close <= day.open;
            return (
              <div key={index} className="flex items-center gap-3 px-3 py-2">
                <label className="flex w-36 items-center gap-2 text-[13px]">
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
            className="w-full resize-y rounded-lg border border-input bg-surface px-3 py-2 text-[13px] leading-normal outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8 disabled:opacity-55"
          />
        </div>

        {settings.canEdit ? (
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
              Salvar
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-ink-3">Só o administrador do restaurante altera o horário.</p>
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
            Automação · fora do horário
          </div>
          <div className="leading-[1.45] break-words whitespace-pre-wrap">{hours.closedMessage}</div>
        </div>
      </div>
    </section>
  );
}
