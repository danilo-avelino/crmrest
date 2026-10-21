"use client";

import {
  CreateTenantRequest,
  formatPhone,
  formatTaxId,
  MODULE_LABEL,
  MODULES,
  type PlatformTenantDto,
  slugify,
  tenantBlock,
  UpdateTenantAccessRequest,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, LogInIcon, PlusIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ComponentProps, useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { StatusBadge } from "@/components/inbox/bits";
import { PlatformHeader, PlatformLoading } from "@/components/platform/platform-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { count, fullDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const TENANTS_KEY = ["platform-tenants"] as const;
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_84px_72px_64px_76px_92px_88px_276px] items-center gap-3";

/**
 * Restaurantes da plataforma (Super Admin, E16; o design ainda não tem este board, segue o padrão de Configurações):
 * uso de cada restaurante, criação com o primeiro administrador, suspensão, acesso de suporte, plano e módulos.
 * Desktop no MVP.
 */
export function PlatformTenants() {
  const { request } = useAuth();
  const tenants = useQuery({ queryKey: TENANTS_KEY, queryFn: () => request<PlatformTenantDto[]>("/platform/tenants") });

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title="Restaurantes" />
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="flex max-w-[1180px] flex-col gap-5">
          <CreateTenantForm />
          {tenants.data ? <TenantList tenants={tenants.data} /> : <PlatformLoading failed={tenants.isError} />}
        </div>
      </div>
    </main>
  );
}

function CreateTenantForm() {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const empty = { name: "", slug: "", adminName: "", adminEmail: "", adminPassword: "" };
  const [form, setForm] = useState(empty);
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof empty | "form", string>>>({});

  const [save, saving] = usePendingAction(async () => {
    const parsed = CreateTenantRequest.safeParse(form);
    if (!parsed.success) {
      const field = (name: keyof typeof empty) => parsed.error.issues.find((issue) => issue.path[0] === name)?.message;
      return setErrors(Object.fromEntries(Object.keys(empty).map((name) => [name, field(name as keyof typeof empty)])));
    }
    setErrors({});
    try {
      queryClient.setQueryData(TENANTS_KEY, await request<PlatformTenantDto[]>("/platform/tenants", { method: "POST", body: parsed.data }));
      void queryClient.invalidateQueries({ queryKey: ["platform-audit"] });
      toast(`${parsed.data.name} foi criado`);
      setForm(empty);
      setSlugEdited(false);
    } catch (failure) {
      setErrors({ form: failure instanceof ApiError ? failure.message : "Não foi possível criar o restaurante." });
    }
  });

  const field = (name: keyof typeof empty, label: string, props: ComponentProps<typeof Input> = {}) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        id={`${id}-${name}`}
        value={form[name]}
        aria-invalid={Boolean(errors[name]) || undefined}
        onChange={(event) => {
          const value = event.target.value;
          if (name === "slug") setSlugEdited(true);
          setForm((current) => ({
            ...current,
            [name]: value,
            ...(name === "name" && !slugEdited ? { slug: slugify(value) } : {}),
          }));
        }}
        {...props}
      />
    </div>
  );

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Novo restaurante</h2>
        <p className="mt-1 text-ink-2">
          O restaurante já nasce com o primeiro administrador, que entra com a senha temporária e cadastra o resto da equipe. Se o
          e-mail já tiver conta, ela ganha acesso ao restaurante e a senha atual continua valendo.
        </p>
      </div>
      <form
        noValidate
        className="bg-paper px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
          {field("name", "Nome do restaurante", { maxLength: 80 })}
          {field("slug", "Endereço (slug)", { maxLength: 60, spellCheck: false })}
        </div>
        <div className="mt-4 mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Primeiro administrador</div>
        <div className="grid grid-cols-3 gap-x-2.5 gap-y-2">
          {field("adminName", "Nome", { maxLength: 80, autoComplete: "off" })}
          {field("adminEmail", "E-mail", { type: "email", autoComplete: "off" })}
          {field("adminPassword", "Senha temporária", { type: "password", maxLength: 128, autoComplete: "new-password" })}
        </div>
        {[...Object.values(errors)].filter(Boolean).map((message) => (
          <p key={message} role="alert" className="mt-2 flex items-center gap-[5px] text-[11px] text-tomate">
            <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
            {message}
          </p>
        ))}
        <div className="mt-3 flex justify-end">
          <Button type="submit" size="sm" loading={saving}>
            <PlusIcon aria-hidden />
            Criar restaurante
          </Button>
        </div>
      </form>
    </section>
  );
}

function TenantList({ tenants }: { tenants: PlatformTenantDto[] }) {
  const active = tenants.filter((t) => t.status === "ACTIVE").length;
  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="flex items-baseline justify-between border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Todos os restaurantes</h2>
        <span className="text-[12px] text-ink-3 tabular-nums">
          {count(tenants.length)} {tenants.length === 1 ? "restaurante" : "restaurantes"} · {count(active)}{" "}
          {active === 1 ? "ativo" : "ativos"}
        </span>
      </div>
      <div
        className={cn(COLUMNS, "border-b border-rule-soft bg-paper px-5 py-2 text-[10px] font-semibold tracking-[0.06em] text-ink-3 uppercase")}
      >
        <span>Restaurante</span>
        <span>Status</span>
        <span className="text-right">Usuários</span>
        <span className="text-right">Canais</span>
        <span className="text-right">Abertas</span>
        <span className="text-right">Msgs 30 dias</span>
        <span>Desde</span>
        <span />
      </div>
      {tenants.length === 0 ? (
        <p className="px-5 py-6 text-ink-3">Nenhum restaurante cadastrado.</p>
      ) : (
        <ul>
          {tenants.map((tenant) => (
            <TenantRow key={tenant.id} tenant={tenant} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TenantRow({ tenant }: { tenant: PlatformTenantDto }) {
  const { request, selectContext } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suspended = tenant.status === "SUSPENDED";

  const setStatus = async (status: PlatformTenantDto["status"]) => {
    setError(null);
    try {
      const updated = await request<PlatformTenantDto[]>(`/platform/tenants/${tenant.id}`, { method: "PATCH", body: { status } });
      queryClient.setQueryData(TENANTS_KEY, updated);
      void queryClient.invalidateQueries({ queryKey: ["platform-audit"] });
      setConfirming(false);
      toast(status === "SUSPENDED" ? `${tenant.name} foi suspenso` : `${tenant.name} foi reativado`);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível alterar o status.");
    }
  };

  // Acesso de suporte: entra como administrador; a entrada fica na auditoria da plataforma.
  const enter = async () => {
    setError(null);
    try {
      await selectContext({ mode: "tenant", tenantId: tenant.id });
      router.push("/inbox");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível entrar no restaurante.");
    }
  };

  return (
    <li className={cn(COLUMNS, "border-b border-rule-soft px-5 py-3 last:border-b-0")}>
      <div className="min-w-0">
        <div className={cn("truncate font-medium", suspended && "text-ink-3")}>{tenant.name}</div>
        <div className="truncate text-[12px] text-ink-3">{tenant.slug}</div>
        {/* Só em quem se cadastrou pelo site: WhatsApp de contato e CPF ou CNPJ para a nota fiscal. */}
        {(tenant.contactPhone || tenant.taxId) && (
          <div className="truncate text-[12px] text-ink-3 tabular-nums">
            {[tenant.contactPhone && formatPhone(tenant.contactPhone), tenant.taxId && formatTaxId(tenant.taxId)].filter(Boolean).join(" · ")}
          </div>
        )}
        {error && <p className="text-[11px] text-tomate">{error}</p>}
      </div>
      <div>{suspended ? <StatusBadge tone="pending">Suspenso</StatusBadge> : <AccessStatus tenant={tenant} />}</div>
      <Metric value={tenant.activeMembers} />
      <Metric value={tenant.connectedChannels} />
      <Metric value={tenant.openConversations} />
      <Metric value={tenant.messagesLast30Days} />
      <span className="text-[12px] text-ink-2 tabular-nums">{fullDate(tenant.createdAt)}</span>
      <div className="flex justify-end gap-1.5">
        <Button variant="outline" size="sm" onClick={() => setManaging(true)}>
          <SlidersHorizontalIcon aria-hidden />
          Plano
        </Button>
        <Button variant="outline" size="sm" disabled={suspended} title={suspended ? "Reative para entrar" : undefined} onClick={enter}>
          <LogInIcon aria-hidden />
          Entrar
        </Button>
        {suspended ? (
          <Button variant="outline" size="sm" onClick={() => setStatus("ACTIVE")}>
            Reativar
          </Button>
        ) : (
          <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
            Suspender
          </Button>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <div className="border-b border-rule-soft px-6 py-5">
            <DialogTitle className="mb-1">Suspender {tenant.name}?</DialogTitle>
            <DialogDescription>{tenant.slug}</DialogDescription>
          </div>
          <div className="px-6 py-[18px]">
            <p className="mb-3.5 text-[13px] leading-relaxed text-ink-2">
              A equipe do restaurante perde o acesso ao painel em até 15 minutos e os canais param de receber mensagens. Os dados
              continuam guardados; dá para reativar quando quiser.
            </p>
            <div className="mb-[18px] flex items-center gap-2 rounded-[7px] border border-[#FDE68A] bg-warning-lt px-3.5 py-2.5">
              <TriangleAlertIcon className="size-3.5 shrink-0 text-[#D97706]" aria-hidden />
              <span className="text-xs text-warning-ink">Esta ação ficará registrada na auditoria da plataforma.</span>
            </div>
            {error && (
              <p role="alert" className="mb-3 flex items-center gap-[5px] text-[11.5px] text-tomate">
                <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="destructive" onClick={() => setStatus("SUSPENDED")}>
                Suspender
              </Button>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={managing} onOpenChange={setManaging}>
        <DialogContent>{managing && <PlanDialog tenant={tenant} />}</DialogContent>
      </Dialog>
    </li>
  );
}

/** "AAAA-MM-DD" daqui a `days` dias, no fuso do navegador (o valor do campo de data). */
function dateInput(days: number): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

/**
 * Plano e módulos de um restaurante: libera o acesso até uma data (pagamento por fora da Stripe ou cortesia, só para
 * quem se cadastrou pelo site) e liga ou desliga os módulos pagos. Tudo fica na auditoria da plataforma.
 */
function PlanDialog({ tenant }: { tenant: PlatformTenantDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const billed = tenant.trialEndsAt !== null;
  const [plan, setPlan] = useState<UpdateTenantAccessRequest["plan"]>(tenant.billingPlan ?? "MONTHLY");
  const [paidUntil, setPaidUntil] = useState(() => dateInput(30));
  const [error, setError] = useState<string | null>(null);

  const apply = (updated: PlatformTenantDto[]) => {
    queryClient.setQueryData(TENANTS_KEY, updated);
    void queryClient.invalidateQueries({ queryKey: ["platform-audit"] });
  };

  const [grant, granting] = usePendingAction(async () => {
    setError(null);
    const parsed = UpdateTenantAccessRequest.safeParse({ plan, paidUntil });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Confira a data.");
    try {
      apply(await request<PlatformTenantDto[]>(`/platform/tenants/${tenant.id}/access`, { method: "PATCH", body: parsed.data }));
      toast(`Acesso de ${tenant.name} liberado até ${fullDate(`${paidUntil}T12:00:00`)}`);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível liberar o acesso.");
    }
  });

  const setModule = async (module: (typeof MODULES)[number], enabled: boolean) => {
    setError(null);
    try {
      apply(await request<PlatformTenantDto[]>(`/platform/tenants/${tenant.id}/modules/${module}`, { method: "PUT", body: { enabled } }));
      toast(`Módulo ${MODULE_LABEL[module]} ${enabled ? "ligado" : "desligado"} em ${tenant.name}`);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível alterar o módulo.");
    }
  };

  return (
    <>
      <div className="border-b border-rule-soft px-6 py-5">
        <DialogTitle className="mb-1">Plano de {tenant.name}</DialogTitle>
        <DialogDescription>{tenant.slug}</DialogDescription>
      </div>
      <div className="flex flex-col gap-5 px-6 py-[18px]">
        <section>
          <div className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Acesso</div>
          {billed ? (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                grant();
              }}
            >
              <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
                {tenant.paidUntil ? `Pago até ${fullDate(tenant.paidUntil)}.` : `Em teste até ${fullDate(tenant.trialEndsAt!)}.`} Para um
                pagamento fora da Stripe (Pix, transferência) ou uma cortesia, libere até o dia combinado.
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-[11px] leading-none font-medium text-ink-2">Plano</legend>
                  <div className="grid h-9 grid-cols-2 rounded-lg border border-input bg-surface p-0.5">
                    {(
                      [
                        ["MONTHLY", "Mensal"],
                        ["ANNUAL", "Anual"],
                      ] as const
                    ).map(([value, label]) => (
                      <label
                        key={value}
                        className={cn(
                          "flex cursor-pointer items-center justify-center rounded-md text-[12px] font-medium transition-colors",
                          plan === value ? "bg-ink text-paper" : "text-ink-3 hover:text-ink-2",
                        )}
                      >
                        <input
                          type="radio"
                          name={`${id}-plan`}
                          value={value}
                          checked={plan === value}
                          onChange={() => setPlan(value)}
                          className="sr-only"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-until`}>Liberado até</Label>
                  <Input
                    id={`${id}-until`}
                    type="date"
                    min={dateInput(0)}
                    value={paidUntil}
                    onChange={(event) => setPaidUntil(event.target.value)}
                  />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button type="submit" size="sm" loading={granting}>
                  Liberar acesso
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-2">Criado pela plataforma: sem cobrança pelo sistema, o acesso não vence.</p>
          )}
        </section>

        <section>
          <div className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Módulos</div>
          <ul className="overflow-hidden rounded-lg border border-rule">
            {MODULES.map((module) => {
              const enabled = tenant.modules.includes(module);
              return (
                <li key={module} className="flex items-center gap-3 border-b border-rule-soft px-3.5 py-2.5 last:border-b-0">
                  <span className="flex-1 font-medium">{MODULE_LABEL[module]}</span>
                  {enabled ? <StatusBadge tone="resolved">Ligado</StatusBadge> : <span className="text-[12px] text-ink-3">Desligado</span>}
                  <Button variant={enabled ? "destructive" : "outline"} size="sm" onClick={() => setModule(module, !enabled)}>
                    {enabled ? "Desligar" : "Ligar"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>

        {error && (
          <p role="alert" className="flex items-center gap-[5px] text-[11.5px] text-tomate">
            <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 rounded-[7px] border border-[#FDE68A] bg-warning-lt px-3.5 py-2.5">
          <TriangleAlertIcon className="size-3.5 shrink-0 text-[#D97706]" aria-hidden />
          <span className="text-xs text-warning-ink">Estas ações ficam registradas na auditoria da plataforma.</span>
        </div>
      </div>
    </>
  );
}

/** Situação de quem se cadastrou pelo site (em teste, pago ou bloqueado até pagar); os outros são só "Ativo". */
function AccessStatus({ tenant }: { tenant: PlatformTenantDto }) {
  if (!tenant.trialEndsAt) return <StatusBadge tone="resolved">Ativo</StatusBadge>;
  const until = tenant.paidUntil ?? tenant.trialEndsAt;
  const block = tenantBlock({ trialEndsAt: new Date(tenant.trialEndsAt), paidUntil: tenant.paidUntil ? new Date(tenant.paidUntil) : null });
  return (
    <>
      {block ? (
        <StatusBadge tone="open">Bloqueado</StatusBadge>
      ) : tenant.paidUntil ? (
        <StatusBadge tone="resolved">Pago</StatusBadge>
      ) : (
        <StatusBadge tone="pending">Em teste</StatusBadge>
      )}
      <div className="mt-0.5 text-[10.5px] text-ink-3 tabular-nums">
        {block ? "desde" : "até"} {fullDate(until)}
      </div>
    </>
  );
}

function Metric({ value }: { value: number }) {
  return <span className={cn("text-right tabular-nums", value === 0 ? "text-ink-3" : "text-ink")}>{count(value)}</span>;
}
