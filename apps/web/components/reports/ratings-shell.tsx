"use client";

import type { AuthContext, IfoodReviewPeriod, RatingsReportDto, ReportPeriod } from "@dishdesk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LayoutDashboardIcon, MessagesSquareIcon, StarIcon, StoreIcon, UsersIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { NavRail } from "@/components/inbox/nav-rail";
import { SideMenu, type SideMenuGroup } from "@/components/layout/side-menu";
import { SettingsHeader } from "@/components/settings/settings-ui";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingState } from "./report-ui";

type Tenant = AuthContext["tenants"][number];

const NAV: SideMenuGroup[] = [
  {
    group: "Atendimento",
    items: [
      { href: "/avaliacoes", label: "Visão geral", icon: LayoutDashboardIcon },
      { href: "/avaliacoes/atendimentos", label: "Atendimentos", icon: MessagesSquareIcon },
      { href: "/avaliacoes/equipe", label: "Equipe", icon: UsersIcon },
    ],
  },
  {
    group: "Clientes",
    items: [
      { href: "/avaliacoes/pesquisa", label: "Pesquisa", icon: StarIcon },
      { href: "/avaliacoes/ifood", label: "iFood", icon: StoreIcon },
    ],
  },
];

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
];

type Ratings = {
  tenant: Tenant;
  period: ReportPeriod;
  setPeriod: (period: ReportPeriod) => void;
  ifoodPeriod: IfoodReviewPeriod;
  setIfoodPeriod: (period: IfoodReviewPeriod) => void;
};

const RatingsContext = createContext<Ratings | null>(null);

/** O restaurante e o período das páginas de Avaliações (o período vale de uma página para a outra). */
export function useRatings(): Ratings {
  const value = useContext(RatingsContext);
  if (!value) throw new Error("useRatings precisa estar dentro de <RatingsShell>");
  return value;
}

/**
 * Avaliações: menu lateral em grupos e, ao lado, a página escolhida, como em Configurações. Só administradores; no
 * painel master, o seletor no topo do menu escolhe o restaurante. Desktop no MVP.
 */
export function RatingsShell({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const adminTenants = (session?.context?.tenants ?? []).filter((t) => t.role === "ADMIN");
  const [tenantId, setTenantId] = useState(() => adminTenants[0]?.id);
  const [period, setPeriod] = useState<ReportPeriod>("7d");
  const [ifoodPeriod, setIfoodPeriod] = useState<IfoodReviewPeriod>("30d");
  const tenant = adminTenants.find((t) => t.id === tenantId) ?? adminTenants[0];
  if (!tenant) return null;

  return (
    <div className="flex h-full overflow-hidden bg-paper">
      <NavRail />
      <SideMenu
        title="Avaliações"
        label="Seções das avaliações"
        root="/avaliacoes"
        nav={NAV}
        tenants={adminTenants}
        tenant={tenant}
        onTenantChange={setTenantId}
      />
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="max-w-[1072px]">
          <RatingsContext value={{ tenant, period, setPeriod, ifoodPeriod, setIfoodPeriod }}>{children}</RatingsContext>
        </div>
      </main>
    </div>
  );
}

/**
 * Uma página do relatório de atendimento: título, período e os dados (as páginas dividem a mesma consulta). `hint`: a
 * dica dos estados vazios, quando ainda há um período maior para tentar.
 */
export function ReportPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: (data: RatingsReportDto, view: { now: number; hint?: string }) => ReactNode;
}) {
  const { request } = useAuth();
  const { tenant, period, setPeriod } = useRatings();
  const now = useNow(60_000);
  const report = useQuery({
    queryKey: ["ratings-report", tenant.id, period],
    queryFn: () => request<RatingsReportDto>(`/reports/ratings?tenantId=${tenant.id}&period=${period}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <SettingsHeader title={title} description={description}>
        <PeriodPicker options={PERIODS} value={period} onChange={setPeriod} />
      </SettingsHeader>
      {report.isPending ? (
        <LoadingState />
      ) : report.isError ? (
        <ErrorState title="Não foi possível carregar as avaliações." onRetry={() => report.refetch()} />
      ) : (
        children(report.data, { now, hint: period === "30d" ? undefined : "Tente 30 dias para ver mais resultados." })
      )}
    </>
  );
}

export function PeriodPicker<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-xl bg-surface-2 p-[3px]" role="group" aria-label="Período">
      {options.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-[12.5px] whitespace-nowrap",
            value === item.value ? "bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(26,24,20,.12)]" : "font-medium text-ink-2 hover:text-ink",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
