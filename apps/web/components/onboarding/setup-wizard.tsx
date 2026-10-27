"use client";

import {
  type AuthContext,
  CHANNEL_LABEL,
  type IntegrationsDto,
  ONBOARDING_INTEGRATIONS,
  ONBOARDING_STEPS,
  type OnboardingDto,
  type OnboardingMark,
  type OnboardingStep,
  type OnboardingStepDto,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PuzzleIcon,
  SkipForwardIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { LogoMark } from "@/components/brand/logo-mark";
import { useIfoodWidget } from "@/components/ifood-widget";
import { doneCount, resumeIndex, STEP_INFO } from "@/components/onboarding/steps";
import { PersonalityTab } from "@/components/settings/automation-texts-tab";
import { BusinessHoursTab } from "@/components/settings/business-hours-tab";
import { IntegrationForm, systemOf, useWhatsAppQr } from "@/components/settings/integrations-tab";
import { MembersTab } from "@/components/settings/members-tab";
import { OrderLinksTab } from "@/components/settings/order-links-section";
import { SettingsTenantProvider } from "@/components/settings/settings-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { clock } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tenant = AuthContext["tenants"][number];
type IntegrationStep = keyof typeof ONBOARDING_INTEGRATIONS;
type SettingStep = Exclude<OnboardingStep, IntegrationStep | "first_message">;

const isIntegration = (step: OnboardingStep): step is IntegrationStep => step in ONBOARDING_INTEGRATIONS;

const INTEGRATION_TEXT: Record<IntegrationStep, { question: string; ask: string; title: string; description: string }> = {
  whatsapp: {
    question: "Você atende pelo WhatsApp?",
    ask: "Conecte o número que os seus clientes já usam. As conversas passam a chegar na Inbox.",
    title: "Conectar o WhatsApp",
    description: "Use o celular do número do restaurante.",
  },
  instagram: {
    question: "Você atende pelo Instagram?",
    ask: "Conecte a conta do restaurante. As mensagens diretas passam a chegar na Inbox.",
    title: "Conectar o Instagram",
    description: "As mensagens diretas da conta do restaurante passam a chegar na Inbox.",
  },
  ifood: {
    question: "Você vende pelo iFood?",
    ask: "Os pedidos das lojas do iFood entram no cadastro do cliente, e o chat do iFood chega na Inbox.",
    title: "Conectar o iFood",
    description: "O responsável pela loja autoriza o Dish Desk no Portal do Parceiro iFood.",
  },
  cardapio_web: {
    question: "Você vende pelo Cardápio Web?",
    ask: "Com a chave da API, os pedidos e os clientes do Cardápio Web chegam ao Dish Desk.",
    title: "Conectar o Cardápio Web",
    description: "Com a chave da API, os pedidos e os clientes do Cardápio Web chegam ao Dish Desk.",
  },
};

/** Os passos de configuração usam as próprias abas de Configurações (o assistente não tem formulários próprios). */
const SETTING_TAB: Record<SettingStep, () => ReactNode> = {
  business_hours: BusinessHoursTab,
  personality: PersonalityTab,
  order_links: OrderLinksTab,
  members: MembersTab,
};

/**
 * Assistente de configuração (E30, board "Configurações · Assistente de configuração"): leva o administrador, passo a
 * passo, até a primeira mensagem de um cliente chegar na Inbox. Dá para sair e continuar depois; o progresso vem da API
 * (o que o restaurante já tem e o que o admin respondeu). No painel master, o restaurante vem em ?restaurante=.
 */
export function SetupWizard() {
  const { session } = useAuth();
  const params = useSearchParams();
  const admins = (session?.context?.tenants ?? []).filter((tenant) => tenant.role === "ADMIN");
  const tenant = admins.find((item) => item.id === params.get("restaurante")) ?? admins[0];
  if (!tenant) return null;
  return <Wizard key={tenant.id} tenant={tenant} showName={admins.length > 1} />;
}

function Wizard({ tenant, showName }: { tenant: Tenant; showName: boolean }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const pathname = usePathname();
  const [index, setIndex] = useState<number | null>(() => (params.has("instagram") ? ONBOARDING_STEPS.indexOf("instagram") : null));
  const [failure, setFailure] = useState<string | null>(null);
  // A tela de abertura (instalar a extensão) só aparece para quem ainda não começou e não voltou do login do Instagram.
  const [intro, setIntro] = useState(() => !params.has("instagram"));
  // Volta do login do Instagram (?instagram=erro&motivo=…): o passo do Instagram mostra o motivo.
  const [instagramFailure] = useState(() =>
    params.get("instagram") === "erro" ? (params.get("motivo") ?? "Não foi possível conectar o Instagram.") : null,
  );
  const onboardingKey = ["onboarding", tenant.id];
  const onboarding = useQuery({
    queryKey: onboardingKey,
    queryFn: () => request<OnboardingDto>(`/onboarding/${tenant.id}`),
    // No passo "Pronto", confere se a primeira mensagem chegou.
    refetchInterval: (query) => (index === ONBOARDING_STEPS.length - 1 && !query.state.data?.firstMessage ? 5_000 : false),
  });
  const integrations = useQuery({
    queryKey: ["integrations", tenant.id],
    queryFn: () => request<IntegrationsDto>(`/integrations?tenantId=${tenant.id}`),
  });

  // Abrir o assistente uma vez basta para ele não abrir mais sozinho.
  const opened = useRef(false);
  useEffect(() => {
    if (params.has("instagram")) window.history.replaceState(null, "", `${pathname}?restaurante=${tenant.id}`);
    if (opened.current) return;
    opened.current = true;
    void request<OnboardingDto>(`/onboarding/${tenant.id}/opened`, { method: "POST" })
      .then((updated) => queryClient.setQueryData(onboardingKey, updated))
      .catch(() => undefined);
  }, []);

  if (!onboarding.data || !integrations.data) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-ink-3" aria-busy={!onboarding.isError && !integrations.isError}>
        {onboarding.isError || integrations.isError ? (
          "Não foi possível carregar o assistente."
        ) : (
          <>
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
            Carregando…
          </>
        )}
      </div>
    );
  }
  const data = onboarding.data;
  const current = index ?? resumeIndex(data);
  const step = ONBOARDING_STEPS[current]!;
  const item = data.steps[current]!;
  const done = doneCount(data);
  const showIntro = intro && index === null && done === 0;

  const go = (target: number) => {
    setFailure(null);
    setIndex(Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, target)));
  };
  const mark = async (target: OnboardingStep, value: OnboardingMark | null) => {
    setFailure(null);
    try {
      queryClient.setQueryData(
        onboardingKey,
        await request<OnboardingDto>(`/onboarding/${tenant.id}/steps/${target}`, { method: "PUT", body: { mark: value } }),
      );
      return true;
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar. Tente de novo.");
      return false;
    }
  };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: onboardingKey }),
      queryClient.invalidateQueries({ queryKey: ["integrations", tenant.id] }),
    ]);
    void queryClient.invalidateQueries({ queryKey: ["channels"] });
  };
  const nav: StepNav = {
    eyebrow: `Passo ${current + 1} de ${ONBOARDING_STEPS.length}${isIntegration(step) ? " · Integrações" : ""}`,
    back: current > 0 ? () => go(current - 1) : undefined,
    next: () => go(current + 1),
    skip: async () => {
      if (await mark(step, "skipped")) go(current + 1);
    },
    mark: (value) => mark(step, value),
  };

  return (
    <div className="flex h-full flex-col bg-paper">
      <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-rule bg-surface px-6">
        <LogoMark />
        <span className="font-heading text-[18px] font-bold tracking-[-0.3px]">Dish Desk</span>
        <span className="h-5 w-px bg-rule" aria-hidden />
        <span className="text-[13px]">
          Configuração do Dish Desk{showName && <span className="text-ink-3"> · {tenant.name}</span>}
        </span>
        <div className="mx-auto flex items-center gap-2.5" aria-label={`${done} de ${ONBOARDING_STEPS.length} passos`}>
          <span className="h-[5px] w-[220px] overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-tomate transition-[width]" style={{ width: `${(done / ONBOARDING_STEPS.length) * 100}%` }} />
          </span>
          <span className="text-[12px] text-ink-2 tabular-nums">
            {done} de {ONBOARDING_STEPS.length} passos
          </span>
        </div>
        <Link href="/inbox" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-[12.5px]")}>
          <XIcon aria-hidden />
          Sair e continuar depois
        </Link>
      </header>

      {showIntro ? (
        <main className="min-w-0 flex-1 overflow-y-auto px-14 py-10">
          <div className="mx-auto max-w-[900px]">
            <ExtensionIntro onManual={() => setIntro(false)} />
          </div>
        </main>
      ) : (
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Passos da configuração" className="w-[300px] shrink-0 overflow-y-auto border-r border-rule bg-surface py-5">
          <StepGroup title="Seu atendimento" steps={data.steps.slice(0, 4)} offset={0} current={current} onPick={go} />
          <StepGroup title="Integrações" steps={data.steps.slice(4)} offset={4} current={current} onPick={go} />
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-14 py-10">
          <div className="mx-auto max-w-[900px]">
            {failure && (
              <p role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-tomate-line bg-tomate-lt px-3.5 py-2.5 text-[12.5px] text-tomate-ink">
                <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
                {failure}
              </p>
            )}
            {isIntegration(step) ? (
              <IntegrationStepView
                key={step}
                step={step}
                item={item}
                tenantId={tenant.id}
                integrations={integrations.data}
                instagramFailure={step === "instagram" ? instagramFailure : null}
                nav={nav}
                onConnected={refresh}
              />
            ) : step === "first_message" ? (
              <ReadyStep onboarding={data} onRestart={() => go(0)} />
            ) : (
              <SettingStepView key={step} step={step} item={item} tenant={tenant} nav={nav} />
            )}
          </div>
        </main>
      </div>
      )}
    </div>
  );
}

const noSubscribe = () => () => {};

function isChrome(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  return brands ? brands.some((item) => item.brand === "Google Chrome") : /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\//.test(navigator.userAgent);
}

/**
 * Abertura do assistente: o jeito recomendado de configurar é pela extensão do Dish Desk no Chrome (o assistente da
 * extensão guia a implantação nas telas do iFood, Instagram e Cardápio Web). Quem não está no Chrome baixa o Chrome
 * primeiro; "Configurar sem a extensão" segue para os passos manuais.
 */
function ExtensionIntro({ onManual }: { onManual: () => void }) {
  const storeUrl = useIfoodWidget().data?.extensionUrl;
  // Null até montar: o navegador só é conhecido no cliente.
  const chrome = useSyncExternalStore(noSubscribe, isChrome, () => null);

  return (
    <StepFrame
      eyebrow="Antes de começar"
      title={chrome === false ? "Use o Google Chrome para configurar" : "Instale a extensão do Dish Desk"}
      description={
        chrome === false
          ? "A configuração é guiada pela extensão do Dish Desk, que só funciona no Google Chrome. Baixe o Chrome, abra o Dish Desk nele e siga pela extensão."
          : "A extensão abre um assistente ao lado da tela e guia você, passo a passo, para conectar o WhatsApp, o Instagram, o iFood e o Cardápio Web."
      }
      footer={
        <>
          <Link href="/inbox" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Sair e continuar depois
          </Link>
          <span className="flex-1" />
          <Button variant="outline" onClick={onManual}>
            Configurar sem a extensão
          </Button>
        </>
      }
    >
      {chrome === null ? null : chrome ? (
        <>
          <Instructions
            items={[
              storeUrl ? (
                <>
                  Clique em <b>Adicionar ao Chrome</b> e confirme a instalação.
                </>
              ) : (
                "Peça ao suporte do Dish Desk o link da extensão e instale no Chrome."
              ),
              <>
                Clique no ícone de quebra-cabeça do Chrome e fixe a extensão <b>Dish Desk</b>.
              </>,
              <>
                Clique no ícone da extensão e escolha <b>Configurar o Dish Desk</b>.
              </>,
            ]}
          />
          {storeUrl && (
            <a href={storeUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants(), "mt-5")}>
              <DownloadIcon aria-hidden />
              Adicionar ao Chrome
            </a>
          )}
        </>
      ) : (
        <>
          <Instructions
            items={[
              <>
                Baixe e instale o <b>Google Chrome</b>.
              </>,
              <>
                Abra o Chrome e entre de novo no Dish Desk (<b>{window.location.host}</b>).
              </>,
              "Instale a extensão do Dish Desk e siga o assistente dela.",
            ]}
          />
          <a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer" className={cn(buttonVariants(), "mt-5")}>
            <DownloadIcon aria-hidden />
            Baixar o Google Chrome
          </a>
        </>
      )}
    </StepFrame>
  );
}

type StepNav = {
  eyebrow: string;
  back?: () => void;
  next: () => void;
  skip: () => Promise<void>;
  mark: (value: OnboardingMark | null) => Promise<boolean>;
};

function StepGroup({
  title,
  steps,
  offset,
  current,
  onPick,
}: {
  title: string;
  steps: OnboardingStepDto[];
  offset: number;
  current: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="mb-3">
      <h2 className="mb-1.5 px-4 text-[10px] font-semibold tracking-[0.1em] text-ink-3 uppercase">{title}</h2>
      <ul>
        {steps.map((item, position) => {
          const index = offset + position;
          const active = index === current;
          const sub =
            item.status === "in_progress" && item.step === "ifood"
              ? "Aguardando o Portal do Parceiro"
              : (item.status === "done" || item.status === "error") && item.detail
                ? item.detail
                : null;
          return (
            <li key={item.step}>
              <button
                type="button"
                aria-current={active ? "step" : undefined}
                onClick={() => onPick(index)}
                className={cn(
                  "flex w-full items-center gap-3 border-l-[3px] px-4 py-2.5 text-left",
                  active ? "border-tomate bg-tomate-lt" : "border-transparent hover:bg-paper",
                )}
              >
                <StepIcon status={item.status} number={index + 1} active={active} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[13px]", active && "font-medium", item.status === "skipped" && "text-ink-3")}>
                    {STEP_INFO[item.step].label}
                  </span>
                  {sub && <span className="block truncate text-[11px] text-ink-3">{sub}</span>}
                </span>
                {item.status === "skipped" && (
                  <span className="shrink-0 rounded-sm border border-rule bg-surface-2 px-1.5 py-px text-[10.5px] text-ink-2">Pulado</span>
                )}
                {item.status === "in_progress" && <Pill tone="warning">Em andamento</Pill>}
                {item.status === "error" && <Pill tone="tomate">Com erro</Pill>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StepIcon({ status, number, active }: { status: OnboardingStepDto["status"]; number: number; active: boolean }) {
  const base = "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums";
  if (status === "done") return <span className={cn(base, "bg-success text-white")}><CheckIcon className="size-3.5" aria-label="Feito" /></span>;
  if (status === "skipped") return <span className={cn(base, "border border-rule bg-surface-2 text-ink-3")}><SkipForwardIcon className="size-3" aria-label="Pulado" /></span>;
  if (status === "in_progress") return <span className={cn(base, "border border-warning-line bg-warning-lt text-warning")}><ClockIcon className="size-3.5" aria-label="Em andamento" /></span>;
  if (status === "error") return <span className={cn(base, "border border-tomate-line bg-tomate-lt text-tomate")}><AlertTriangleIcon className="size-3" aria-label="Com erro" /></span>;
  return <span className={cn(base, active ? "bg-ink text-paper" : "border border-rule text-ink-3")}>{number}</span>;
}

function Pill({ tone, children }: { tone: "warning" | "tomate"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-px text-[10.5px]",
        tone === "warning" ? "border-warning-line bg-warning-lt text-warning-ink" : "border-tomate-line bg-tomate-lt text-tomate-ink",
      )}
    >
      <span className={cn("size-[5px] rounded-full", tone === "warning" ? "bg-warning" : "bg-tomate")} aria-hidden />
      {children}
    </span>
  );
}

/** O cartão do passo atual: título, explicação, a ação e o rodapé Voltar · Pular · Continuar. */
function StepFrame({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow: string;
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-rule bg-surface px-[30px] pt-7 pb-5">
      <p className="text-[12px] text-ink-3">{eyebrow}</p>
      {title && <h1 className="mt-1.5 font-heading text-[26px] leading-tight font-bold tracking-[-0.5px]">{title}</h1>}
      {description && <p className="mt-1.5 text-[13.5px] leading-normal text-ink-2">{description}</p>}
      {children && <div className="mt-6">{children}</div>}
      {footer && <div className="mt-6 flex items-center gap-2 border-t border-rule pt-5">{footer}</div>}
    </section>
  );
}

function Footer({ nav, skip = true, children }: { nav: StepNav; skip?: boolean; children: ReactNode }) {
  return (
    <>
      {nav.back && (
        <Button variant="ghost" size="sm" onClick={nav.back}>
          Voltar
        </Button>
      )}
      <span className="flex-1" />
      {skip && (
        <Button variant="outline" onClick={nav.skip}>
          Pular
        </Button>
      )}
      {children}
    </>
  );
}

function Instructions({ items }: { items: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 text-[13px] leading-normal">
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border border-rule bg-paper text-[11px] font-medium text-ink-2 tabular-nums">
            {index + 1}
          </span>
          <span className="pt-px">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Connected({ title, detail, children }: { title: string; detail?: string | null; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-success-line bg-success-lt px-4 py-3.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success text-white">
        <CheckIcon className="size-4" aria-hidden />
      </span>
      <div className="text-success-ink">
        <p className="text-[13px] font-semibold">{title}</p>
        {detail && <p className="text-[12px]">{detail}</p>}
        {children}
      </div>
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-tomate-line bg-tomate-lt px-4 py-3 text-[12.5px] leading-normal text-tomate-ink">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-tomate" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * Um passo de integração. Antes, a pergunta ("Você atende pelo WhatsApp?"); "Sim" abre o passo a passo, que usa a mesma
 * conexão de Configurações → Integrações; o Dish Desk confere a conexão antes de o passo contar como feito.
 */
function IntegrationStepView({
  step,
  item,
  tenantId,
  integrations,
  instagramFailure,
  nav,
  onConnected,
}: {
  step: IntegrationStep;
  item: OnboardingStepDto;
  tenantId: string;
  integrations: IntegrationsDto;
  instagramFailure: string | null;
  nav: StepNav;
  onConnected: () => Promise<void>;
}) {
  const text = INTEGRATION_TEXT[step];
  const label = CHANNEL_LABEL[ONBOARDING_INTEGRATIONS[step]];
  const [asking, setAsking] = useState(() => (item.status === "todo" || item.status === "skipped") && !instagramFailure);

  if (item.status === "done") {
    return (
      <StepFrame
        eyebrow={nav.eyebrow}
        title={text.title}
        description="Tudo certo com a conexão."
        footer={
          <Footer nav={nav} skip={false}>
            <Button onClick={nav.next}>Continuar</Button>
          </Footer>
        }
      >
        <Connected title={`${label} conectado`} detail={item.detail}>
          {/* A base de clientes da loja é importada ao conectar (Configurações → Integrações). */}
          {step === "cardapio_web" && <p className="mt-1 text-[12px]">Os clientes da loja estão sendo importados para Clientes, sem duplicar quem já existe.</p>}
        </Connected>
        {step === "ifood" && <ExtensionCard />}
      </StepFrame>
    );
  }

  if (asking) {
    return (
      <StepFrame
        eyebrow={nav.eyebrow}
        title={text.question}
        description={text.ask}
        footer={
          <Footer nav={nav} skip={false}>
            <Button disabled>Continuar</Button>
          </Footer>
        }
      >
        <div className="flex gap-2">
          <Button
            onClick={async () => {
              if (item.status === "skipped" && !(await nav.mark(null))) return;
              setAsking(false);
            }}
          >
            Sim, conectar
          </Button>
          <Button variant="outline" onClick={nav.skip}>
            Agora não
          </Button>
        </div>
      </StepFrame>
    );
  }

  // iFood: sem a autorização do Portal ainda, "Seguir para o próximo" deixa o passo em andamento.
  const waitIfood = step === "ifood" && item.status !== "in_progress";
  return (
    <StepFrame
      eyebrow={nav.eyebrow}
      title={text.title}
      description={step === "ifood" && item.status === "in_progress" ? "Falta a autorização da loja no Portal do Parceiro iFood." : text.description}
      footer={
        <Footer nav={nav}>
          {step === "ifood" ? (
            <Button
              onClick={async () => {
                if (waitIfood && !(await nav.mark("in_progress"))) return;
                nav.next();
              }}
            >
              Seguir para o próximo
            </Button>
          ) : (
            <Button disabled>Continuar</Button>
          )}
        </Footer>
      }
    >
      {item.status === "error" && (
        <Problem>
          {item.detail ? `${item.detail} está` : `O ${label} está`} conectado, mas com erro. Conecte de novo para voltar a receber as mensagens e os pedidos.
        </Problem>
      )}
      {step === "whatsapp" && <WhatsAppConnect tenantId={tenantId} enabled={integrations.platform.whatsappQr} onConnected={onConnected} />}
      {step === "instagram" && <InstagramConnect tenantId={tenantId} enabled={integrations.platform.instagramLogin} failure={instagramFailure} />}
      {step === "ifood" && (
        <>
          {item.status === "in_progress" && (
            <div className="mb-5 flex items-start gap-3 rounded-xl border border-warning-line bg-warning-lt px-4 py-3.5 text-warning-ink">
              <ClockIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="flex items-center gap-2 text-[13px] font-semibold">
                  Aguardando o iFood <Pill tone="warning">Em andamento</Pill>
                </p>
                <p className="mt-1 text-[12.5px] leading-normal">
                  Quando o Portal do Parceiro mostrar o código de autorização, cole aqui embaixo para terminar. O passo fica em andamento até lá.
                </p>
              </div>
            </div>
          )}
          <IntegrationForm system={systemOf("IFOOD")} tenantId={tenantId} ifoodLinkCode={integrations.platform.ifoodLinkCode} onClose={() => void onConnected()} bare />
          <ExtensionCard />
        </>
      )}
      {step === "cardapio_web" && (
        <div className="grid grid-cols-2 gap-10">
          <Instructions
            items={[
              "Entre no Portal do Cardápio Web com a conta do restaurante.",
              <>
                Vá em <b>Configurações → Integrações → API</b>.
              </>,
              "Gere a chave e copie o código.",
              "Cole a chave e o código da loja nos campos ao lado.",
            ]}
          />
          <IntegrationForm system={systemOf("CARDAPIO_WEB")} tenantId={tenantId} ifoodLinkCode={false} onClose={() => void onConnected()} bare />
        </div>
      )}
    </StepFrame>
  );
}

/** WhatsApp: o QR Code aparece aqui mesmo e o passo confirma sozinho quando o número conecta. */
function WhatsAppConnect({ tenantId, enabled, onConnected }: { tenantId: string; enabled: boolean; onConnected: () => Promise<void> }) {
  const qr = useWhatsAppQr(tenantId, () => void onConnected());
  // Ao sair do passo sem conectar, a tentativa é apagada (a função mais recente sabe qual é).
  const stop = useRef(qr.stop);
  useEffect(() => {
    stop.current = qr.stop;
  });
  useEffect(() => {
    if (enabled) void qr.start();
    return () => stop.current();
  }, []);

  if (!enabled) return <p className="text-ink-3">A conexão do WhatsApp por QR Code ainda não foi configurada neste servidor.</p>;
  return (
    <>
      <div className="grid grid-cols-[1fr_auto] gap-10">
        <Instructions
          items={[
            "Abra o WhatsApp ou o WhatsApp Business no celular.",
            <>
              Toque em <b>Aparelhos conectados</b>.
            </>,
            <>
              Toque em <b>Conectar um aparelho</b>.
            </>,
            "Aponte a câmera para o QR Code.",
          ]}
        />
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-[172px] items-center justify-center rounded-xl border border-rule bg-surface p-2">
            {qr.qr ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL gerada pela Evolution, trocada a cada poucos segundos
              <img src={qr.qr} alt="QR Code para conectar o WhatsApp" className="size-full" />
            ) : (
              <p className="px-3 text-center text-[12px] text-ink-3">{qr.failure ? "QR Code indisponível" : "Gerando o QR Code…"}</p>
            )}
          </div>
          <p className="text-[11px] text-ink-3">O QR Code se atualiza sozinho</p>
        </div>
      </div>
      {qr.failure && (
        <div className="mt-4 flex items-center gap-3">
          <p role="alert" className="text-[12px] text-tomate">
            {qr.failure}
          </p>
          <Button variant="outline" size="sm" onClick={qr.start}>
            Gerar outro QR Code
          </Button>
        </div>
      )}
      <p className="mt-5 text-[11.5px] leading-normal text-ink-3">
        O número continua funcionando no celular. Para o WhatsApp não bloquear o número, não mande mensagens em massa para quem nunca falou com o
        restaurante, e abra o WhatsApp no celular pelo menos uma vez a cada 14 dias.
      </p>
    </>
  );
}

/** Instagram: a conta precisa ser profissional; o login do Instagram volta para o assistente. */
function InstagramConnect({ tenantId, enabled, failure: returned }: { tenantId: string; enabled: boolean; failure: string | null }) {
  const { request } = useAuth();
  const [failure, setFailure] = useState(returned);

  const login = async () => {
    setFailure(null);
    try {
      const { url } = await request<{ url: string }>(`/integrations/${tenantId}/instagram/login?origem=assistente`);
      window.location.assign(url);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível abrir o login do Instagram.");
    }
  };

  return (
    <>
      {failure && <Problem>{failure}</Problem>}
      <Instructions
        items={[
          <>
            Confira se a conta do restaurante é <b>Profissional</b>: no Instagram, Configurações → Tipo de conta e ferramentas.
          </>,
          "Entre com a conta e autorize o Dish Desk a ler e responder as mensagens.",
        ]}
      />
      <Button className="mt-5" disabled={!enabled} onClick={login}>
        <span className="size-2 rounded-full bg-instagram" aria-hidden />
        Entrar com o Instagram
      </Button>
      {!enabled && <p className="mt-2 text-[12px] text-ink-3">O login do Instagram ainda não foi configurado neste servidor.</p>}
    </>
  );
}

/** A extensão do Chrome leva o chat do iFood para a Inbox (sem o endereço na loja do Chrome, o cartão não aparece). */
function ExtensionCard() {
  const url = useIfoodWidget().data?.extensionUrl;
  if (!url) return null;
  return (
    <div className="mt-5 flex items-center gap-3 rounded-xl border border-rule px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
        <PuzzleIcon className="size-4 text-ink-2" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">Instale a extensão do Dish Desk no Chrome</p>
        <p className="text-[11.5px] text-ink-3">Ela leva o chat do iFood para a Inbox.</p>
      </div>
      <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
        <DownloadIcon aria-hidden />
        Adicionar ao Chrome
      </a>
    </div>
  );
}

/**
 * Horário, personalidade, links e convites: a aba de Configurações dentro do assistente. "Continuar" sem salvar nada
 * mantém o padrão (conta como feito).
 */
function SettingStepView({ step, item, tenant, nav }: { step: SettingStep; item: OnboardingStepDto; tenant: Tenant; nav: StepNav }) {
  const Tab = SETTING_TAB[step];
  return (
    <StepFrame
      eyebrow={nav.eyebrow}
      footer={
        <Footer nav={nav}>
          <Button
            onClick={async () => {
              if (item.status !== "done" && !(await nav.mark("confirmed"))) return;
              nav.next();
            }}
          >
            Continuar
          </Button>
        </Footer>
      }
    >
      <SettingsTenantProvider tenant={tenant}>
        <Tab />
      </SettingsTenantProvider>
    </StepFrame>
  );
}

/** Passo 9: espera a primeira mensagem de um cliente (o teste de outro celular) e comemora quando ela chega. */
function ReadyStep({ onboarding, onRestart }: { onboarding: OnboardingDto; onRestart: () => void }) {
  const steps = Object.fromEntries(onboarding.steps.map((item) => [item.step, item]));
  const channel = (["whatsapp", "instagram", "ifood"] as const).find((step) => steps[step]?.status === "done");
  const message = onboarding.firstMessage;

  if (message) {
    return (
      <section className="relative overflow-hidden rounded-xl border border-rule bg-surface px-8 py-12 text-center">
        <Confetti />
        <span className="relative mx-auto flex size-[84px] items-center justify-center rounded-full bg-success text-white">
          <CheckIcon className="size-9" aria-hidden />
        </span>
        <h1 className="relative mt-5 font-heading text-[26px] font-bold tracking-[-0.5px]">A primeira mensagem chegou!</h1>
        <p className="relative mt-1 text-ink-2">O Dish Desk está pronto para atender.</p>
        <div className="relative mx-auto mt-5 flex w-fit items-end gap-2 text-left">
          <span className="size-[22px] shrink-0 rounded-full bg-[#E8DCC4]" aria-hidden />
          <div className="max-w-[320px] rounded-[12px_12px_12px_2px] border border-rule bg-surface px-3 py-2">
            <p className="text-[13px] leading-[1.4] break-words">{message.text}</p>
            <p className="mt-0.5 text-right text-[10px] text-ink-3 tabular-nums">
              {clock(message.at)} · {CHANNEL_LABEL[message.channelType]}
            </p>
          </div>
        </div>
        <Link href="/inbox" className={cn(buttonVariants({ variant: "accent" }), "relative mt-6")}>
          Abrir a Inbox
        </Link>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-rule bg-surface px-8 py-12 text-center">
      <span className="mx-auto flex size-[104px] items-center justify-center rounded-full bg-paper">
        <span className="flex size-[84px] items-center justify-center rounded-full bg-surface-2">
          <MessageSquareIcon className="size-7 text-ink-2" aria-hidden />
        </span>
      </span>
      {channel ? (
        <>
          <span className="mt-3 flex justify-center gap-1.5" aria-hidden>
            {[0, 1, 2].map((dot) => (
              <span key={dot} className="size-[7px] animate-pulse rounded-full bg-rule" style={{ animationDelay: `${dot * 200}ms` }} />
            ))}
          </span>
          <h1 className="mt-4 font-heading text-[26px] font-bold tracking-[-0.5px]">Esperando a primeira mensagem</h1>
          <p className="mx-auto mt-1 max-w-[420px] leading-normal text-ink-2">
            {channel === "whatsapp" ? (
              <>
                Mande um “oi” de outro celular para <b className="tabular-nums">{steps.whatsapp?.detail}</b>.
              </>
            ) : channel === "instagram" ? (
              <>
                Mande uma mensagem direta para <b>{steps.instagram?.detail}</b> de outra conta do Instagram.
              </>
            ) : (
              "Quando um cliente escrever pelo chat de um pedido do iFood, a conversa chega aqui."
            )}{" "}
            Quando chegar, levamos você para a Inbox.
          </p>
          <Link href="/inbox" className={cn(buttonVariants({ variant: "outline" }), "mt-6")}>
            Ir para a Inbox agora
          </Link>
        </>
      ) : (
        <>
          <h1 className="mt-5 font-heading text-[26px] font-bold tracking-[-0.5px]">Conecte um canal para receber mensagens</h1>
          <p className="mx-auto mt-1 max-w-[420px] leading-normal text-ink-2">
            As mensagens dos clientes chegam pelo WhatsApp, pelo Instagram ou pelo chat do iFood. Conecte pelo menos um deles.
          </p>
          <Button className="mt-6" onClick={onRestart}>
            Voltar às integrações
          </Button>
        </>
      )}
    </section>
  );
}

/** Confete parado ao redor do check (board "Pronto · chegou"). */
const CONFETTI = [
  [18, 12, -30, "bg-tomate"],
  [26, 34, 20, "bg-ink"],
  [12, 58, 60, "bg-success"],
  [32, 70, -15, "bg-[#E8DCC4]"],
  [70, 14, 40, "bg-tomate"],
  [78, 36, -50, "bg-[#E8DCC4]"],
  [84, 60, 10, "bg-ink"],
  [66, 72, 70, "bg-success"],
  [40, 8, 80, "bg-success"],
  [58, 6, -20, "bg-ink"],
  [22, 82, 35, "bg-tomate"],
  [76, 84, -40, "bg-tomate"],
] as const;

function Confetti() {
  return (
    <span aria-hidden>
      {CONFETTI.map(([left, top, rotate, color], index) => (
        <span
          key={index}
          className={cn("absolute h-[3px] w-[11px] rounded-full", color)}
          style={{ left: `${left}%`, top: `${top}%`, rotate: `${rotate}deg` }}
        />
      ))}
    </span>
  );
}
