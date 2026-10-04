"use client";

import type { SelectContextRequest } from "@comanda/shared";
import { ChevronRightIcon, LayersIcon, LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

// Cores das iniciais na ordem do design.
const BADGE_COLORS = ["bg-tomate", "bg-[#1A2D3A]", "bg-[#2A1A34]"];
const ROLE_LABEL = { ADMIN: "Admin", AGENT: "Atendente" } as const;

/** Painel direito (escuro) do board "Login · Escolha de restaurante". */
export function TenantChooser() {
  const { session, selectContext } = useAuth();
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [choose, pending] = usePendingAction(async (request: SelectContextRequest, key: string) => {
    setChoosing(key);
    setError(null);
    try {
      await selectContext(request);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível entrar. Tente novamente.");
    } finally {
      setChoosing(null);
    }
  });

  const tenants = session?.tenants ?? [];
  const totalOpen = tenants.reduce((sum, tenant) => sum + tenant.openConversations, 0);

  return (
    <section className="relative flex flex-1 flex-col overflow-hidden bg-ink">
      {/* Textura de comanda: linhas sutis a cada 32px. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_31px,rgba(247,244,239,0.03)_31px,rgba(247,244,239,0.03)_32px)]"
      />

      <div className="relative flex flex-1 flex-col items-center justify-center p-16">
        {session ? (
          <>
            <div className="mb-2.5 flex size-14 items-center justify-center rounded-full border-[1.5px] border-[#3D3A34] bg-[#2D2A24]">
              <span className="text-lg font-semibold text-[#DDD8D0]">{session.user.name.charAt(0)}</span>
            </div>
            <p className="mb-11 text-[12.5px] text-[#5C5750]">
              {session.user.name} · {session.user.email}
            </p>

            <h2 className="mb-1.5 text-center font-heading text-[21px] font-semibold tracking-[-0.3px] text-paper">
              Escolha o restaurante
            </h2>
            <p className="mb-7 text-center text-[13px] text-[#5C5750]">
              {tenants.length === 0
                ? "Você ainda não tem acesso a nenhum restaurante. Peça acesso ao admin."
                : `Você tem acesso a ${tenants.length} ${tenants.length === 1 ? "espaço" : "espaços"}.`}
            </p>

            <div className="flex w-full max-w-[380px] flex-col gap-1.5">
              {tenants.map((tenant, index) => (
                <ChooserItem
                  key={tenant.id}
                  badge={<span className="font-heading text-[14px] font-bold tracking-[-0.5px] text-white">{initials(tenant.name)}</span>}
                  badgeClassName={BADGE_COLORS[index % BADGE_COLORS.length]!}
                  title={tenant.name}
                  subtitle={`${ROLE_LABEL[tenant.role]} · ${openLabel(tenant.openConversations)}`}
                  active={tenant.openConversations > 0}
                  loading={choosing === tenant.id}
                  disabled={pending}
                  onClick={() => choose({ mode: "tenant", tenantId: tenant.id }, tenant.id)}
                />
              ))}

              {/* Painel master (§5.1.1): não existe no design; segue o padrão visual dos itens. */}
              {tenants.length >= 2 && (
                <>
                  <div className="my-2 flex items-center gap-3">
                    <div className="h-px flex-1 bg-[#2A2720]" />
                    <span className="text-[11px] text-[#5C5750]">ou</span>
                    <div className="h-px flex-1 bg-[#2A2720]" />
                  </div>
                  <ChooserItem
                    badge={<LayersIcon className="size-[18px] text-paper" aria-hidden />}
                    badgeClassName="bg-[#3D3A34]"
                    title="Painel master"
                    subtitle={`Todos os ${tenants.length} restaurantes · ${openLabel(totalOpen)}`}
                    active={totalOpen > 0}
                    loading={choosing === "master"}
                    disabled={pending}
                    onClick={() => choose({ mode: "master" }, "master")}
                  />
                </>
              )}
            </div>

            {error && (
              <p role="alert" className="mt-4 text-[12px] text-[#F5B5AC]">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <h2 className="mb-1.5 text-center font-heading text-[21px] font-semibold tracking-[-0.3px] text-paper">
              Seu atendimento numa só comanda
            </h2>
            <p className="text-center text-[13px] text-[#5C5750]">WhatsApp, Instagram e iFood no mesmo lugar.</p>
          </>
        )}
      </div>

      <footer className="relative flex items-center gap-3 border-t border-[#242118] px-10 py-[18px]">
        <span className="size-[5px] rounded-full bg-success" />
        <Clock />
      </footer>
    </section>
  );
}

function ChooserItem(props: {
  badge: ReactNode;
  badgeClassName: string;
  title: string;
  subtitle: string;
  active: boolean;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-busy={props.loading || undefined}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border border-[#2A2720] px-4 py-[13px] text-left transition-colors",
        "hover:border-[#3D3A34] hover:bg-[#2D2A24] focus-visible:border-[#3D3A34] focus-visible:bg-[#2D2A24] focus-visible:outline-none",
        "disabled:cursor-not-allowed",
        props.loading && "border-[#3D3A34] bg-[#2D2A24]",
      )}
    >
      <div className={cn("flex size-[38px] shrink-0 items-center justify-center rounded-[7px]", props.badgeClassName)}>
        {props.badge}
      </div>
      <div className="flex-1">
        <div className="mb-0.5 text-[14px] text-[#C0B8B0] group-hover:text-paper group-focus-visible:text-paper">
          {props.title}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[#5C5750]">
          <span className={cn("size-[5px] shrink-0 rounded-full", props.active ? "bg-success" : "bg-[#5C5750]")} />
          {props.loading ? "Carregando…" : props.subtitle}
        </div>
      </div>
      {props.loading ? (
        <LoaderCircleIcon className="size-3.5 animate-spin text-[#5C5750]" aria-hidden />
      ) : (
        <ChevronRightIcon className="size-3.5 text-[#5C5750]" aria-hidden />
      )}
    </button>
  );
}

/** Dia e hora no rodapé decorativo ("Sex, 19:47"). */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(now).replace(".", "");
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(now);
  return (
    // A hora do servidor e a do navegador diferem na hidratação: é esperado aqui.
    <p suppressHydrationWarning className="font-heading text-[12.5px] tracking-[0.02em] text-[#3D3A34] italic">
      {`${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${time}`}
    </p>
  );
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter((word) => word.length > 2);
  return (words.length ? words : [name]).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("");
}

function openLabel(count: number): string {
  if (count === 0) return "sem conversas abertas";
  return count === 1 ? "1 conversa aberta" : `${count} conversas abertas`;
}
