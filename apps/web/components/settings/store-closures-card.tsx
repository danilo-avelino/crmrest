"use client";

import { activeClosureAt, closureLabel, MAX_STORE_CLOSURES, type StoreClosure, type TenantSettingsDto, UpdateStoreClosuresRequest } from "@dishdesk/shared";
import { useState } from "react";
import { useCurrentSettings, useSaveSettings } from "@/components/settings/use-settings";
import { TabLoading } from "@/components/settings/settings-shell";
import { Card, CardBody, CardFooter } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

const REASONS = ["Feriado", "Falta de energia", "Férias coletivas", "Manutenção"];

/** "2026-12-24T18:00" do campo de data e hora, no horário de Brasília, vira o instante ISO. */
const isoOf = (local: string) => new Date(`${local}:00-03:00`).toISOString();

/** Cartão de pausas da página Horário, com o carregamento das configurações. */
export function StoreClosuresSection() {
  const { current, failed } = useCurrentSettings();
  return current ? <StoreClosuresCard key={current.tenantId} settings={current} /> : <TabLoading failed={failed} />;
}

/**
 * Pausas no atendimento da loja: feriado programado ou imprevisto (falta de energia). Durante a pausa, a IA diz que a
 * loja está fechada e o motivo, o aviso de fora do horário sai e o cardápio digital não aceita pedidos.
 */
export function StoreClosuresCard({ settings }: { settings: TenantSettingsDto }) {
  const saveSettings = useSaveSettings();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [startsNow, setStartsNow] = useState(true);
  const [from, setFrom] = useState("");
  const [open, setOpen] = useState(true);
  const [until, setUntil] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const now = new Date();
  const closures = settings.closures;
  const active = activeClosureAt({ ...settings.businessHours, closures }, now);

  const store = async (next: StoreClosure[], done: string) => {
    setFailure(null);
    const parsed = UpdateStoreClosuresRequest.safeParse({ closures: next });
    if (!parsed.success) return setFailure(parsed.error.issues[0]?.message ?? "Confira a pausa.");
    try {
      await saveSettings(settings.tenantId, "closures", parsed.data);
      toast(done);
      return true;
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  };

  const [add, adding] = usePendingAction(async () => {
    if (!startsNow && !from) return setFailure("Informe quando a pausa começa.");
    if (!open && !until) return setFailure("Informe quando o atendimento volta, ou marque “Sem previsão”.");
    const closure: StoreClosure = {
      id: crypto.randomUUID(),
      from: startsNow ? now.toISOString() : isoOf(from),
      until: open ? null : isoOf(until),
      reason,
    };
    if (await store([...closures, closure], startsNow ? "Atendimento pausado" : "Pausa programada")) {
      setReason("");
      setFrom("");
      setUntil("");
    }
  });

  const disabled = !settings.canEdit;
  return (
    <Card
      title="Pausas no atendimento"
      description="Para feriados ou imprevistos, como falta de energia. Durante a pausa, a IA diz ao cliente que a loja está fechada e o motivo, quem precisa de uma pessoa recebe a mensagem de fora do horário e o cardápio digital não aceita pedidos. As outras automações seguem normais (diferente da página Pausa, que desliga o Dish Desk). Horário de Brasília."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <CardBody className="flex flex-col gap-5">
          {active && (
            <p className="rounded-lg border border-tomate bg-tomate-lt px-3.5 py-2.5 text-[13px] text-ink">
              <span className="font-medium">Atendimento pausado agora</span> · {active.reason}, {closureLabel(active)}
            </p>
          )}

          {closures.length > 0 && (
            <ul className="flex flex-col divide-y divide-rule-soft rounded-xl border border-rule-soft">
              {closures.map((closure) => {
                const current = closure === active;
                return (
                  <li key={closure.id} className="flex min-h-[48px] items-center gap-3 px-3.5 py-2">
                    <span className="flex-1">
                      <span className="block text-[13px] font-medium">
                        {closure.reason}
                        {current && <span className="ml-2 text-[11px] font-medium text-tomate">agora</span>}
                      </span>
                      <span className="block text-[12px] text-ink-3 tabular-nums">{closureLabel(closure)}</span>
                    </span>
                    {!disabled && (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() =>
                          current
                            ? store(
                                closures.map((item) => (item.id === closure.id ? { ...item, until: new Date().toISOString() } : item)),
                                "Atendimento retomado",
                              )
                            : store(
                                closures.filter((item) => item.id !== closure.id),
                                "Pausa removida",
                              )
                        }
                      >
                        {current ? "Retomar agora" : "Remover"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {!disabled && closures.length < MAX_STORE_CLOSURES && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="closure-reason">Motivo</Label>
                <Input
                  id="closure-reason"
                  maxLength={120}
                  value={reason}
                  placeholder="Ex.: falta de energia"
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {REASONS.map((item) => (
                    <Button key={item} type="button" variant="outline" size="xs" onClick={() => setReason(item)}>
                      {item}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-6">
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-[13px] font-medium">Começa</legend>
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="radio" checked={startsNow} onChange={() => setStartsNow(true)} className="accent-ink" />
                    Agora
                  </label>
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="radio" checked={!startsNow} onChange={() => setStartsNow(false)} className="accent-ink" />
                    Em
                    <Input
                      type="datetime-local"
                      aria-label="Começa em"
                      value={from}
                      onChange={(event) => {
                        setFrom(event.target.value);
                        setStartsNow(false);
                      }}
                      className="h-8 w-52 tabular-nums"
                    />
                  </label>
                </fieldset>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-[13px] font-medium">Volta</legend>
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="radio" checked={open} onChange={() => setOpen(true)} className="accent-ink" />
                    Sem previsão (retomo à mão)
                  </label>
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="radio" checked={!open} onChange={() => setOpen(false)} className="accent-ink" />
                    Em
                    <Input
                      type="datetime-local"
                      aria-label="Volta em"
                      value={until}
                      onChange={(event) => {
                        setUntil(event.target.value);
                        setOpen(false);
                      }}
                      className="h-8 w-52 tabular-nums"
                    />
                  </label>
                </fieldset>
              </div>
            </div>
          )}
        </CardBody>
        <CardFooter error={failure} note={settings.canEdit ? undefined : "Só o administrador do restaurante altera as pausas."}>
          {settings.canEdit && (
            <Button type="submit" size="sm" loading={adding} disabled={!reason.trim()}>
              {startsNow ? "Pausar agora" : "Programar pausa"}
            </Button>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
