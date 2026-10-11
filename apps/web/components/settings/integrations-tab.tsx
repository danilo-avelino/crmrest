"use client";

import {
  AddIntegrationRequest,
  CHANNEL_LABEL,
  type IntegrationDto,
  type IntegrationsDto,
  type IntegrationType,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, CircleAlertIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { IFOOD_WIDGET_KEY } from "@/components/ifood-widget";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { type FacebookSdk, loadFacebookSdk, runEmbeddedSignup } from "@/lib/embedded-signup";
import { cn } from "@/lib/utils";

type Field = { name: string; label: string; placeholder?: string; secret?: boolean; numeric?: boolean };

const GROUPS = ["Canais de atendimento", "Marketplaces"] as const;

/**
 * Cada sistema: o que a integração faz, como identificar a conta e, quando a conexão é por formulário, o que pedir.
 * O Instagram conecta pelo login do Instagram; o WhatsApp, pela janela da Meta (com o formulário só sem ela).
 */
const SYSTEMS: {
  type: IntegrationType;
  group: (typeof GROUPS)[number];
  /** Título do modal, quando não é só o nome do sistema. */
  title?: string;
  /** Linha de apoio no painel "Adicionar integração". */
  summary: string;
  description: string;
  /** Rótulos de uma conta: o nome dela e o identificador no sistema de origem. */
  account: string;
  idLabel: string;
  another: string;
  tip?: string;
  help?: string;
  fields?: Field[];
}[] = [
  {
    type: "WHATSAPP",
    group: "Canais de atendimento",
    title: "WhatsApp Business API",
    summary: "WhatsApp Business API",
    description: "Números da WhatsApp Cloud API (Meta). As conversas de cada número chegam na Inbox.",
    account: "Número conectado",
    idLabel: "ID do número",
    another: "Adicionar outro número",
    tip: "Para receber mensagens, o número deve estar ativo no WhatsApp Business Manager com a conta aprovada pela Meta.",
    help: "No app da Meta, em WhatsApp → Configuração da API. Use o token permanente de um usuário do sistema; o número precisa estar registrado na Cloud API.",
    fields: [
      { name: "phoneNumberId", label: "ID do número", placeholder: "Ex.: 997004416819345", numeric: true },
      { name: "wabaId", label: "ID da conta do WhatsApp Business (WABA)", placeholder: "Ex.: 25239395755710258", numeric: true },
      { name: "accessToken", label: "Token de acesso", secret: true },
    ],
  },
  {
    type: "INSTAGRAM",
    group: "Canais de atendimento",
    summary: "Mensagens diretas (DMs)",
    description: "Contas profissionais do Instagram. As DMs chegam na Inbox.",
    account: "Conta conectada",
    idLabel: "ID da conta",
    another: "Adicionar outra conta",
  },
  {
    type: "IFOOD",
    group: "Marketplaces",
    summary: "Pedidos",
    description: "Lojas do iFood. Os pedidos entram no cadastro do cliente e abrem conversas na Inbox.",
    account: "Loja conectada",
    idLabel: "ID da loja",
    another: "Adicionar outra loja",
    help: "O ID da loja (merchant ID) aparece no Portal do Parceiro do iFood.",
    fields: [
      { name: "merchantId", label: "ID da loja (merchant ID)" },
      { name: "name", label: "Nome (opcional)", placeholder: "Ex.: Loja Centro" },
    ],
  },
  {
    type: "CARDAPIO_WEB",
    group: "Marketplaces",
    summary: "Pedidos e base de clientes",
    description: "Lojas do Cardápio Web. Ao conectar, a base de clientes da loja é importada; os pedidos entram no cadastro do cliente, achado pelo telefone.",
    account: "Loja conectada",
    idLabel: "Código da loja",
    another: "Adicionar outra loja",
    help: "A chave fica no Portal do Cardápio Web, em Configurações → Integrações → API. Ela é testada antes de salvar.",
    fields: [
      { name: "storeId", label: "Código da loja", placeholder: "Ex.: 13047", numeric: true },
      { name: "apiKey", label: "Chave de API", secret: true },
      { name: "name", label: "Nome (opcional)", placeholder: "Ex.: Loja Centro" },
    ],
  },
];

type System = (typeof SYSTEMS)[number];

type Badge = { label: string; className: string; dot: string };

const STATUS: Record<IntegrationDto["status"], Badge> = {
  CONNECTED: { label: "Conectado", className: "bg-success-lt text-success-ink", dot: "bg-success" },
  ERROR: { label: "Com erro", className: "bg-tomate-lt text-tomate-ink", dot: "bg-tomate" },
  DISCONNECTED: { label: "Desconectado", className: "bg-surface-2 text-ink-3", dot: "bg-ink-3" },
};

/** Ícone do sistema: quadrado na cor do canal com o símbolo em branco. */
const ICONS: Record<IntegrationType, { tile: string; glyph: ReactNode }> = {
  WHATSAPP: {
    tile: "bg-whatsapp",
    glyph: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-[54%]">
        <path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.08-1.35C8.46 21.52 10.2 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm5.26 14.52c-.22.62-1.29 1.18-1.77 1.22-.46.04-.88.2-2.98-.62-2.52-1-4.12-3.57-4.24-3.73-.12-.16-1-1.33-1-2.53 0-1.2.63-1.79.85-2.03.22-.24.48-.3.64-.3h.46c.15 0 .35-.06.55.42.2.5.68 1.66.74 1.78.06.12.1.26.02.42-.08.16-.12.26-.24.4-.12.14-.25.31-.36.42-.12.12-.24.24-.1.47.14.23.62 1.02 1.33 1.65.91.81 1.68 1.06 1.91 1.18.23.12.36.1.49-.06.13-.16.56-.65.71-.87.15-.22.3-.18.5-.11.2.07 1.27.6 1.49.71.22.11.36.16.42.25.05.09.05.53-.17 1.14z" />
      </svg>
    ),
  },
  INSTAGRAM: {
    tile: "bg-[linear-gradient(135deg,#f09433_0%,#e6683c_25%,#dc2743_50%,#cc2366_75%,#bc1888_100%)]",
    glyph: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-[48%]">
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
      </svg>
    ),
  },
  IFOOD: { tile: "bg-ifood", glyph: <span className="font-heading font-bold">iF</span> },
  CARDAPIO_WEB: {
    tile: "bg-cardapio-web",
    glyph: (
      <svg viewBox="0 0 20 16" fill="none" stroke="currentColor" strokeLinecap="round" className="w-[48%]">
        <rect x="1" y="1" width="18" height="14" rx="2" strokeWidth="1.4" />
        <path d="M5 6h10M5 9.5h7" strokeWidth="1.3" />
      </svg>
    ),
  },
};

function SystemIcon({ type, className }: { type: IntegrationType; className: string }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center text-white", ICONS[type].tile, className)}>
      {ICONS[type].glyph}
    </span>
  );
}

function StatusBadge({ badge, className }: { badge: Badge; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-[5px] rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.02em]", badge.className, className)}>
      <span className={cn("size-[5px] rounded-full", badge.dot)} aria-hidden />
      {badge.label}
    </span>
  );
}

/** Credencial da plataforma que falta neste servidor: as lojas ficam cadastradas, mas os pedidos não chegam. */
function pendingOf(type: IntegrationType, platform: IntegrationsDto["platform"]) {
  if (type === "IFOOD" && !platform.ifood) {
    return {
      badge: "Credencial pendente",
      text: "A credencial da plataforma iFood ainda não foi configurada: as lojas ficam cadastradas, mas os pedidos só chegam depois disso.",
    };
  }
  if (type === "CARDAPIO_WEB" && !platform.cardapioWeb) {
    return {
      badge: "Conexão desligada",
      text: "A conexão com a API do Cardápio Web está desligada neste servidor: a chave não é testada e os pedidos só chegam depois que ela for ligada.",
    };
  }
  return null;
}

/**
 * Aba "Integrações" (board Configurações · Integrações): um cartão por sistema que dá para conectar; o cartão abre
 * o modal com as contas conectadas e a nova conexão. "Adicionar integração" abre o painel com todos os sistemas.
 */
export function IntegrationsTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  // Volta do login do Instagram (?instagram=…): o modal do Instagram já abre, para mostrar o resultado.
  const params = useSearchParams();
  const [modal, setModal] = useState(() => ({ type: "INSTAGRAM" as IntegrationType, adding: false, open: params.has("instagram") }));
  const [catalog, setCatalog] = useState(false);
  const integrations = useQuery({
    queryKey: ["integrations", tenant.id],
    queryFn: () => request<IntegrationsDto>(`/integrations?tenantId=${tenant.id}`),
  });
  if (!integrations.data) return <TabLoading failed={integrations.isError} />;
  const data = integrations.data;

  return (
    <>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-[21px] font-bold tracking-[-0.3px]">Integrações</h2>
          <p className="mt-1 text-ink-3">Conecte canais de atendimento e marketplaces ao Dish Desk</p>
        </div>
        {data.canEdit && (
          <Button variant="accent" onClick={() => setCatalog(true)}>
            <PlusIcon aria-hidden />
            Adicionar integração
          </Button>
        )}
      </div>

      {GROUPS.map((group) => (
        <div key={group} className="mb-6">
          <h3 className="mb-2.5 text-[10px] font-bold tracking-[0.09em] text-ink-3 uppercase">{group}</h3>
          {SYSTEMS.filter((system) => system.group === group).map((system) => (
            <IntegrationCard
              key={system.type}
              system={system}
              data={data}
              onOpen={(adding) => setModal({ type: system.type, adding, open: true })}
            />
          ))}
        </div>
      ))}

      <Dialog open={catalog} onOpenChange={setCatalog}>
        <DialogContent className="top-0 right-0 left-auto flex h-full w-[460px] translate-x-0 translate-y-0 flex-col rounded-none">
          <Catalog
            onClose={() => setCatalog(false)}
            onPick={(type) => {
              setCatalog(false);
              setModal({ type, adding: true, open: true });
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={modal.open} onOpenChange={(open) => setModal((current) => ({ ...current, open }))}>
        <DialogContent className="w-[560px] rounded-[16px]">
          <IntegrationPanel
            system={SYSTEMS.find((system) => system.type === modal.type)!}
            data={data}
            adding={modal.adding}
            onClose={() => setModal((current) => ({ ...current, open: false }))}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Cartão de um sistema: a situação e as contas conectadas; o botão abre o modal (direto na nova conexão, se não há conta). */
function IntegrationCard({ system, data, onOpen }: { system: System; data: IntegrationsDto; onOpen: (adding: boolean) => void }) {
  const items = data.integrations.filter((integration) => integration.type === system.type);
  const active = items.filter((item) => item.status !== "DISCONNECTED");
  const pending = pendingOf(system.type, data.platform);
  // Situação do sistema: credencial pendente, alguma conta com erro, conectado ou sem nenhuma conta.
  const badge: Badge = pending
    ? { label: pending.badge, className: "bg-warning-lt text-warning-ink", dot: "bg-warning" }
    : active.some((item) => item.status === "ERROR")
      ? STATUS.ERROR
      : active.length > 0
        ? STATUS.CONNECTED
        : { ...STATUS.DISCONNECTED, label: "Não conectado" };

  return (
    <section
      className={cn("mb-2 flex gap-3.5 rounded-2xl border border-rule-soft bg-surface px-[18px] py-[15px]", active.length > 1 ? "items-start" : "items-center")}
      aria-labelledby={`integracao-${system.type}`}
    >
      <SystemIcon type={system.type} className="size-[42px] rounded-[10px] text-[13px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 id={`integracao-${system.type}`} className="text-[14px] font-semibold">
            {CHANNEL_LABEL[system.type]}
          </h4>
          <StatusBadge badge={badge} />
        </div>
        {active.length > 1 ? (
          <ul className="mt-2 flex flex-col gap-[5px]">
            {active.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-sm bg-paper text-ink-3" aria-hidden>
                  <svg viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeLinecap="round" className="size-[9px]">
                    <rect x="1" y="1" width="7" height="7" rx="1" />
                    <path d="M2.5 3.5h4M2.5 5.5h2.5" strokeWidth=".8" />
                  </svg>
                </span>
                <span className="truncate text-[12px]">{item.name}</span>
                <span className="truncate text-[11px] text-ink-3 tabular-nums">
                  {system.idLabel} {item.externalId}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-[3px] truncate text-[11px] text-ink-3 tabular-nums">
            {active[0] ? `${active[0].name} · ${system.idLabel} ${active[0].externalId}` : system.description}
          </p>
        )}
      </div>
      <Button variant="outline" size="sm" className="text-ink-2" onClick={() => onOpen(active.length === 0)}>
        {active.length > 0 ? "Gerenciar" : "Conectar"}
      </Button>
    </section>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Fechar" className="ml-auto rounded-xl bg-paper text-ink-3" onClick={onClick}>
      <XIcon aria-hidden />
    </Button>
  );
}

/** Painel "Adicionar integração": todos os sistemas, por grupo, com busca pelo nome. Escolher um abre o modal dele. */
function Catalog({ onClose, onPick }: { onClose: () => void; onPick: (type: IntegrationType) => void }) {
  const [search, setSearch] = useState("");
  const found = SYSTEMS.filter((system) => CHANNEL_LABEL[system.type].toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <div className="flex shrink-0 items-start border-b border-surface-2 px-6 py-[22px]">
        <div>
          <DialogTitle className="text-[16px]">Adicionar integração</DialogTitle>
          <DialogDescription className="mt-[3px]">Escolha um canal ou serviço</DialogDescription>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="relative shrink-0 border-b border-paper px-6 py-3.5">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-[38px] size-[13px] -translate-y-1/2 text-ink-3" aria-hidden />
        <Input
          type="search"
          aria-label="Buscar integração"
          placeholder="Buscar integração…"
          className="rounded-xl border-transparent bg-paper pl-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="flex-1 overflow-y-auto pb-2">
        {GROUPS.map((group) => {
          const systems = found.filter((system) => system.group === group);
          if (systems.length === 0) return null;
          return (
            <div key={group}>
              <h3 className="px-6 pt-3.5 pb-1.5 text-[9px] font-bold tracking-widest text-tomate uppercase">{group}</h3>
              {systems.map((system) => (
                <Button
                  key={system.type}
                  variant="ghost"
                  className="h-auto w-full justify-start gap-3 rounded-none px-6 py-[9px] text-left"
                  onClick={() => onPick(system.type)}
                >
                  <SystemIcon type={system.type} className="size-9 rounded-[9px] text-[12px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink">{CHANNEL_LABEL[system.type]}</span>
                    <span className="mt-px block text-[11px] font-normal text-ink-3">{system.summary}</span>
                  </span>
                  <ChevronRightIcon className="size-3.5 text-rule" aria-hidden />
                </Button>
              ))}
            </div>
          );
        })}
        {found.length === 0 && <p className="px-6 py-4 text-ink-3">Nenhuma integração com esse nome.</p>}
      </div>
    </>
  );
}

/** Modal de um sistema: as contas conectadas, a nova conexão (formulário ou janela do sistema) e a confirmação para desconectar. */
function IntegrationPanel({ system, data, adding, onClose }: { system: System; data: IntegrationsDto; adding: boolean; onClose: () => void }) {
  const label = CHANNEL_LABEL[system.type];
  const items = data.integrations.filter((integration) => integration.type === system.type);
  const signup = system.type === "WHATSAPP" ? data.platform.whatsappSignup : null;
  // "details": as contas; "form": nova integração por formulário; uma conta: a confirmação antes de desconectá-la.
  const [view, setView] = useState<"details" | "form" | IntegrationDto>(
    adding && data.canEdit && system.type !== "INSTAGRAM" && !signup ? "form" : "details",
  );
  const tip = pendingOf(system.type, data.platform)?.text ?? system.tip;
  const addLabel = items.some((item) => item.status !== "DISCONNECTED") ? system.another : `Conectar o ${label}`;
  const canDisconnect = (item: IntegrationDto) => data.canEdit && item.status !== "DISCONNECTED";
  // Uma conta só: "Desconectar" fica no rodapé, como no board; com várias, cada conta tem o seu.
  const only = items.length === 1 ? items[0] : undefined;

  let action: ReactNode;
  if (!data.canEdit) action = <p className="text-[12px] text-ink-3">Só o administrador do restaurante adiciona integrações.</p>;
  else if (system.type === "INSTAGRAM") action = <InstagramLogin tenantId={data.tenantId} enabled={data.platform.instagramLogin} label={addLabel} />;
  else if (signup) action = <WhatsAppSignup tenantId={data.tenantId} ids={signup} label={addLabel} />;
  else action = <AddButton onClick={() => setView("form")}>{addLabel}</AddButton>;

  return (
    <>
      <div className="flex items-center gap-3.5 border-b border-surface-2 px-[26px] py-[22px]">
        <SystemIcon type={system.type} className="size-[46px] rounded-2xl text-[14px]" />
        <div className="min-w-0">
          <DialogTitle className="text-[16px]">{system.title ?? label}</DialogTitle>
          <DialogDescription className="mt-0.5 truncate">
            {view === "details" ? "Detalhes da conexão" : view === "form" ? "Nova integração" : `Desconectar ${view.name}?`}
          </DialogDescription>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      {view === "form" ? (
        <IntegrationForm system={system} tenantId={data.tenantId} onClose={() => setView("details")} />
      ) : view !== "details" ? (
        <DisconnectConfirm tenantId={data.tenantId} item={view} onClose={() => setView("details")} />
      ) : (
        <div className="max-h-[calc(100vh-11rem)] overflow-y-auto px-[26px] py-[22px]">
          {items.length === 0 && <p className="mb-4 leading-normal text-ink-2">{system.description}</p>}
          {items.map((item) => (
            <div key={item.id} className="mb-4 border-surface-2 [&+&]:border-t [&+&]:pt-4">
              <div className="mb-5 flex items-center justify-between gap-3">
                <StatusBadge badge={STATUS[item.status]} className="gap-1.5 px-3 py-1 text-[11px]" />
                {!only && canDisconnect(item) && (
                  <Button variant="destructive" size="xs" className="border-tomate-line bg-tomate-lt" onClick={() => setView(item)}>
                    Desconectar
                  </Button>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-3">
                <div className="rounded-[10px] bg-paper px-[15px] py-[13px]">
                  <dt className="mb-[5px] text-[10px] font-bold tracking-[0.07em] text-ink-3 uppercase">{system.account}</dt>
                  <dd className="text-[15px] font-bold break-words">{item.name}</dd>
                </div>
                <div className="rounded-[10px] bg-paper px-[15px] py-[13px]">
                  <dt className="mb-[5px] text-[10px] font-bold tracking-[0.07em] text-ink-3 uppercase">{system.idLabel}</dt>
                  <dd className="text-[12px] font-semibold break-all tabular-nums">{item.externalId}</dd>
                </div>
              </dl>
            </div>
          ))}
          {tip && (
            <p className="mb-[22px] flex items-start gap-[9px] rounded-xl border border-warning-line bg-warning-lt px-[13px] py-[11px] text-[11px] leading-[1.55] text-warning-ink">
              <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              {tip}
            </p>
          )}
          <div className="flex items-start justify-between gap-3">
            {action}
            {only && canDisconnect(only) && (
              <Button variant="destructive" className="border-tomate-line bg-tomate-lt font-bold" onClick={() => setView(only)}>
                Desconectar
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** "Adicionar outro número" / "Conectar o …": ação em tomate do rodapé do modal. */
function AddButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => unknown; disabled?: boolean }) {
  return (
    <Button variant="ghost" disabled={disabled} className="-ml-2 px-2 text-tomate hover:bg-tomate-lt hover:text-tomate" onClick={onClick}>
      <PlusIcon aria-hidden />
      {children}
    </Button>
  );
}

function Failure({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2 text-[11.5px] text-tomate">
      {children}
    </p>
  );
}

/** Instagram: o botão abre a tela de login do Instagram; a volta (pela API) traz o resultado no endereço. */
function InstagramLogin({ tenantId, enabled, label }: { tenantId: string; enabled: boolean; label: string }) {
  const { request } = useAuth();
  const toast = useToast();
  // Volta do login: ?instagram=conectado ou ?instagram=erro&motivo=…; o endereço é limpo para o aviso não se repetir.
  const params = useSearchParams();
  const result = params.get("instagram");
  const [failure, setFailure] = useState<string | null>(
    result && result !== "conectado" ? (params.get("motivo") ?? "Não foi possível conectar o Instagram.") : null,
  );

  useEffect(() => {
    if (!result) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (result === "conectado") toast("Instagram conectado");
  }, []);

  async function login() {
    setFailure(null);
    try {
      const { url } = await request<{ url: string }>(`/integrations/${tenantId}/instagram/login`);
      window.location.assign(url);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível abrir o login do Instagram.");
    }
  }

  return (
    <div>
      <AddButton disabled={!enabled} onClick={login}>
        {label}
      </AddButton>
      {!enabled && <p className="mt-2 text-[11.5px] text-ink-3">O login do Instagram ainda não foi configurado neste servidor.</p>}
      {failure && <Failure>{failure}</Failure>}
    </div>
  );
}

/**
 * WhatsApp: abre o cadastro incorporado da Meta. Quem já usa o app WhatsApp Business escolhe conectar o app e
 * escaneia um QR code com o celular (Coexistência): o número continua funcionando no app.
 */
function WhatsAppSignup({ tenantId, ids, label }: { tenantId: string; ids: { appId: string; configId: string }; label: string }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [sdk, setSdk] = useState<FacebookSdk | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // O SDK carrega antes do clique: a janela da Meta precisa abrir no próprio clique, senão o navegador a bloqueia.
  useEffect(() => {
    loadFacebookSdk(ids.appId).then(setSdk, (error: Error) => setFailure(error.message));
  }, [ids.appId]);

  async function connect() {
    if (!sdk) return;
    setFailure(null);
    try {
      const result = await runEmbeddedSignup(sdk, ids.configId);
      if (!result) return; // janela fechada
      await request(`/integrations/${tenantId}/whatsapp/signup`, { method: "POST", body: result });
      await queryClient.invalidateQueries({ queryKey: ["integrations", tenantId] });
      toast("WhatsApp conectado");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Não foi possível conectar o WhatsApp.");
    }
  }

  return (
    <div>
      <AddButton disabled={!sdk} onClick={connect}>
        {label}
      </AddButton>
      {failure && <Failure>{failure}</Failure>}
    </div>
  );
}

/** Confirmação antes de desconectar: as mensagens e os pedidos da conta param de chegar. */
function DisconnectConfirm({ tenantId, item, onClose }: { tenantId: string; item: IntegrationDto; onClose: () => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [failure, setFailure] = useState<string | null>(null);

  async function disconnect() {
    setFailure(null);
    try {
      await request(`/integrations/${tenantId}/${item.id}/disconnect`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["integrations", tenantId] });
      if (item.type === "IFOOD") void queryClient.invalidateQueries({ queryKey: IFOOD_WIDGET_KEY });
      toast(`${item.name} desconectado`);
      onClose();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível desconectar.");
    }
  }

  return (
    <div className="px-[26px] py-[22px]">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-2">
        As mensagens e os pedidos desta conta deixam de chegar, e as respostas pela Inbox não são mais enviadas por ela. As
        conversas e os pedidos já recebidos continuam no Dish Desk. Para voltar, adicione a integração de novo.
      </p>
      {failure && <p role="alert" className="mb-3 text-[11.5px] text-tomate">{failure}</p>}
      <div className="flex gap-2">
        <Button variant="destructive" onClick={disconnect}>
          Desconectar
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/** Formulário de uma nova integração: a API confere a credencial no sistema antes de salvar. */
function IntegrationForm({ system, tenantId, onClose }: { system: System; tenantId: string; onClose: () => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const label = CHANNEL_LABEL[system.type];
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const [submit, saving] = usePendingAction(async () => {
    setFailure(null);
    // Campos em branco (o nome opcional) ficam de fora.
    const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
    const parsed = AddIntegrationRequest.safeParse({ type: system.type, ...filled });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.code === "invalid_type" ? "Preencha este campo." : issue.message;
      setErrors(next);
      return;
    }
    try {
      await request(`/integrations/${tenantId}`, { method: "POST", body: parsed.data });
      await queryClient.invalidateQueries({ queryKey: ["integrations", tenantId] });
      // Loja iFood nova: o widget do iFood já liga, sem recarregar a página.
      if (system.type === "IFOOD") void queryClient.invalidateQueries({ queryKey: IFOOD_WIDGET_KEY });
      toast(`Integração com o ${label} adicionada`);
      onClose();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível conectar.");
    }
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-2.5 px-[26px] py-[22px]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {system.fields?.map((field) => (
        <div key={field.name} className="flex flex-col gap-1">
          <Label htmlFor={`${id}-${field.name}`}>{field.label}</Label>
          <Input
            id={`${id}-${field.name}`}
            type={field.secret ? "password" : "text"}
            inputMode={field.numeric ? "numeric" : undefined}
            // Credenciais não devem ser lembradas pelo navegador.
            autoComplete={field.secret ? "new-password" : "off"}
            placeholder={field.placeholder}
            value={values[field.name] ?? ""}
            aria-invalid={Boolean(errors[field.name]) || undefined}
            onChange={(event) => {
              setValues((current) => ({ ...current, [field.name]: event.target.value }));
              setErrors((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== field.name)));
            }}
          />
          {errors[field.name] && (
            <p role="alert" className="text-[11px] text-tomate">
              {errors[field.name]}
            </p>
          )}
        </div>
      ))}
      <p className="text-[11.5px] leading-normal text-ink-3">{system.help}</p>
      {failure && (
        <p role="alert" className="text-[11px] text-tomate">
          {failure}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" loading={saving}>
          Conectar
        </Button>
      </div>
    </form>
  );
}
