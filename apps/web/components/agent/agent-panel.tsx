"use client";

import {
  type AgentPageAction,
  type AgentSessionDto,
  type AgentSessionKind,
  type AgentSupportMessageDto,
  type AgentTurnDto,
  type AgentTurnRequest,
  ONBOARDING_INTEGRATIONS,
  type OnboardingDto,
  type OnboardingStep,
  supportReturn,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  GlobeIcon,
  LoaderCircleIcon,
  LockIcon,
  MessageSquareIcon,
  MousePointerClickIcon,
  PauseIcon,
  PlayIcon,
  SkipForwardIcon,
  SparklesIcon,
  SquareIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { LogoMark } from "@/components/brand/logo-mark";
import { doneCount, resumeIndex, STEP_INFO } from "@/components/onboarding/steps";
import { Button } from "@/components/ui/button";
import { agentBridge, extensionPanel, indicate, onPageEvent } from "@/lib/agent-bridge";
import { type AgentTurnApi, answerConfirmation, answerPermission, type RunOptions, runAgent } from "@/lib/agent-driver";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

type Card =
  | { type: "confirm"; action: AgentPageAction; say: string }
  | { type: "your_turn"; say: string }
  | { type: "permission"; host: string }
  | { type: "paused"; auto: boolean }
  | { type: "lost"; say: string }
  | { type: "step_done"; step: OnboardingStep; next: OnboardingStep | null }
  | { type: "handoff" }
  | { type: "off_hours"; when: string }
  | { type: "unavailable" };

type Entry = { id: number } & (
  | { kind: "partner"; text: string }
  | { kind: "agent"; text: string }
  | {
      kind: "action";
      action: AgentPageAction;
      state: "running" | "done" | "failed";
    }
  | { kind: "card"; card: Card }
);

type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id"> : never) : never;

/** working: a IA age; waiting: espera o parceiro; support: passada para a equipe do Dish Desk; done: implantação concluída. */
type Phase = "idle" | "working" | "waiting" | "paused" | "support" | "unavailable" | "done";

/** O que o parceiro escreveu no início e parece implantação (o resto vai para o suporte). */
const SETUP_WORDS = /configur|implant|conect|integra|whats|zap|insta|ifood|card[aá]pio/i;
/** Depois da transferência, o painel confere as respostas da equipe. */
const SUPPORT_POLL_MS = 10_000;

const HOSTS: [RegExp, string][] = [
  [/(^|\.)portal\.ifood\.com\.br$/, "o Portal do Parceiro iFood"],
  [/(^|\.)cardapioweb\.com$/, "o Portal do Cardápio Web"],
  [/(^|\.)instagram\.com$/, "o Instagram"],
  [/(^|\.)facebook\.com$/, "o Meta Business"],
];

/**
 * Painel lateral da extensão do Chrome (E31, board "Extensão do Chrome · Agente de implantação e suporte"): a conversa
 * com a IA que mexe no navegador junto com o parceiro. A ponte com a aba é o agent-bridge; o ciclo, o agent-driver.
 */
export function AgentPanel() {
  const { session, loading, reload } = useAuth();

  // O login acontece numa aba do Dish Desk: ao voltar para o painel, a sessão é buscada de novo.
  useEffect(() => {
    if (session?.context) return;
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [session?.context, reload]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-paper text-ink-3" aria-busy>
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
        Carregando…
      </div>
    );
  }
  const tenants = session?.context?.tenants ?? [];
  const tenant = tenants.find((item) => item.role === "ADMIN") ?? tenants[0];
  if (!tenant) return <SignedOut />;
  return <Conversation key={tenant.id} tenantId={tenant.id} admin={tenant.role === "ADMIN"} />;
}

function SignedOut() {
  return (
    <div className="flex h-full flex-col bg-paper">
      <Header mode={null} status={{ label: "Desconectado", tone: "off" }} />
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <LogoMark className="size-[52px] rounded-xl [&_svg]:size-7" />
        <h1 className="mt-5 font-heading text-[20px] font-bold tracking-[-0.3px]">Entre no Dish Desk para começar</h1>
        <p className="mt-1.5 text-[12.5px] leading-normal text-ink-2">A IA usa a sua conta para configurar e conferir as integrações.</p>
        <Button className="mt-5" onClick={() => window.open(`${window.location.origin}/login`, "_blank")}>
          Entrar no Dish Desk
        </Button>
      </div>
    </div>
  );
}

function Conversation({ tenantId, admin }: { tenantId: string; admin: boolean }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [mode, setMode] = useState<AgentSessionKind | null>(null);
  const [progress, setProgress] = useState<OnboardingDto | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // A sessão na ref (o ciclo assíncrono lê a atual) e o id no estado (a tela).
  const sessionRef = useRef<AgentSessionDto | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const progressRef = useRef<OnboardingDto | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const abortRef = useRef<{
    controller: AbortController;
    reason: "auto" | "manual" | "stop" | null;
  } | null>(null);
  const nextId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const onboarding = useQuery({
    queryKey: ["onboarding", tenantId],
    queryFn: () => request<OnboardingDto>(`/onboarding/${tenantId}`),
    enabled: admin,
  });
  const supportKey = ["agent-support", sessionId];
  const support =
    useQuery({
      queryKey: supportKey,
      queryFn: () => request<AgentSupportMessageDto[]>(`/agent/sessions/${sessionId}/messages`),
      enabled: phase === "support" && sessionId !== null,
      refetchInterval: SUPPORT_POLL_MS,
    }).data ?? [];

  const setSession = (next: AgentSessionDto | null) => {
    sessionRef.current = next;
    setSessionId(next?.id ?? null);
  };
  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };
  const push = (...items: NewEntry[]) => setEntries((current) => [...current, ...items.map((item) => ({ ...item, id: ++nextId.current }) as Entry)]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [entries, support, phase]);

  // A faixa na aba: Pausar e Continuar, e o parceiro mexendo na página enquanto a IA age (pausa sozinha).
  const handlers = useRef({
    pause: (_auto: boolean) => undefined as void,
    resume: () => undefined as void,
  });
  useEffect(
    () =>
      onPageEvent((event) => {
        if (event === "user-input") {
          if (phaseRef.current === "working") handlers.current.pause(true);
        } else if (event === "pause") handlers.current.pause(false);
        else handlers.current.resume();
      }),
    [],
  );
  useEffect(() => () => indicate({ state: "off" }), []);

  const api: AgentTurnApi = (body: AgentTurnRequest) =>
    request<AgentTurnDto>(`/agent/sessions/${sessionRef.current!.id}/turn`, {
      method: "POST",
      body,
    });

  async function startSession(kind: AgentSessionKind) {
    setSession(
      await request<AgentSessionDto>("/agent/sessions", {
        method: "POST",
        body: { tenantId, kind },
      }),
    );
    setMode(kind);
  }

  /** Um passo de integração que acabou de ser conferido vira o cartão "Passo concluído". */
  function applyProgress(next: OnboardingDto | null) {
    if (!next) return;
    const before = progressRef.current;
    progressRef.current = next;
    setProgress(next);
    if (!before) return;
    for (const item of next.steps) {
      const was = before.steps.find((old) => old.step === item.step)?.status;
      if (item.step in ONBOARDING_INTEGRATIONS && item.status === "done" && was !== "done") {
        const upcoming = next.steps.find((candidate) => candidate.status === "todo" || candidate.status === "error");
        push({
          kind: "card",
          card: {
            type: "step_done",
            step: item.step,
            next: upcoming?.step ?? null,
          },
        });
      }
    }
  }

  /** Roda o ciclo do agente até ele precisar do parceiro, mostrando cada ação; depois, o cartão do que vem. */
  async function run(call: (options: RunOptions) => Promise<AgentTurnDto>, opening?: AgentPageAction) {
    const abort = {
      controller: new AbortController(),
      reason: null as "auto" | "manual" | "stop" | null,
    };
    abortRef.current = abort;
    setPhase("working");
    indicate({ state: "controlling" });
    if (opening) push({ kind: "action", action: opening, state: "running" });
    let first = true;
    const options: RunOptions = {
      signal: abort.controller.signal,
      onStep: (turn) => {
        if (turn.next.type !== "act") return;
        applyProgress(turn.progress);
        if (first) push({ kind: "agent", text: turn.next.say });
        first = false;
        push({ kind: "action", action: turn.next.action, state: "running" });
        indicate({
          state: "controlling",
          ...("ref" in turn.next.action && { ref: turn.next.action.ref }),
        });
      },
      onResult: (result) =>
        setEntries((current) => {
          const index = current.findLastIndex((entry) => entry.kind === "action" && entry.state === "running");
          if (index === -1) return current;
          return current.map((entry, i) => (i === index ? ({ ...entry, state: result.ok ? "done" : "failed" } as Entry) : entry));
        }),
    };
    try {
      finish(await call(options), abort.reason);
    } catch (error) {
      indicate({ state: "off" });
      // Sessão encerrada (ex.: terminou em outra aba): a próxima mensagem começa outra.
      if (error instanceof ApiError && error.status === 422) setSession(null);
      push({
        kind: "agent",
        text: error instanceof ApiError ? error.message : "Não consegui falar com o Dish Desk agora. Tente de novo.",
      });
      setPhase("idle");
    }
  }

  function finish(turn: AgentTurnDto, reason: "auto" | "manual" | "stop" | null) {
    applyProgress(turn.progress);
    const next = turn.next;
    const kind = sessionRef.current?.kind;
    if (turn.status !== "ACTIVE" && next.type !== "handoff") setSession(null);
    switch (next.type) {
      case "act":
        // Parou antes da ação (Pausar ou Parar) ou chegou ao limite de ações seguidas.
        if (reason === "stop") return stopped();
        if (reason) return paused(reason === "auto");
        push({
          kind: "agent",
          text: "Fiz várias ações seguidas. Quer que eu continue?",
        });
        return waiting();
      case "reply":
        push({ kind: "agent", text: next.say });
        return waiting();
      case "confirm":
        push({
          kind: "card",
          card: { type: "confirm", action: next.action, say: next.say },
        });
        return waiting("ref" in next.action ? next.action.ref : undefined);
      case "your_turn":
        push({ kind: "card", card: { type: "your_turn", say: next.say } });
        if (next.ref !== null) void agentBridge.focus(next.ref).catch(() => undefined);
        setPhase("waiting");
        return indicate({
          state: "waiting",
          ...(next.ref !== null && { ref: next.ref }),
          mark: "your_turn",
        });
      case "permission":
        push({ kind: "agent", text: next.say }, { kind: "card", card: { type: "permission", host: next.host } });
        return waiting();
      case "lost":
        push({ kind: "card", card: { type: "lost", say: next.say } });
        return waiting();
      case "unavailable":
        indicate({ state: "off" });
        push({ kind: "card", card: { type: "unavailable" } });
        return setPhase("unavailable");
      case "handoff":
        return handedOff();
      case "done":
        push({ kind: "agent", text: next.say });
        indicate({ state: "off" });
        return setPhase(kind === "SETUP" && turn.progress?.completed ? "done" : "idle");
    }
  }

  function waiting(ref?: number) {
    setPhase("waiting");
    indicate({ state: "waiting", ...(ref !== undefined && { ref }) });
  }
  function paused(auto: boolean) {
    push({ kind: "card", card: { type: "paused", auto } });
    setPhase("paused");
    indicate({ state: "paused" });
  }
  function stopped() {
    push({
      kind: "agent",
      text: "Parei. Quando quiser continuar, é só pedir.",
    });
    setPhase("idle");
    indicate({ state: "off" });
  }
  function handedOff() {
    indicate({ state: "off" });
    const when = supportReturn(new Date());
    push({
      kind: "card",
      card: when ? { type: "off_hours", when } : { type: "handoff" },
    });
    setMode("SUPPORT");
    setPhase("support");
  }

  function stop() {
    if (phaseRef.current === "working" && abortRef.current) {
      abortRef.current.reason = "stop";
      abortRef.current.controller.abort();
    } else stopped();
  }

  /** Guard de duplo clique dos botões dos cartões e do campo (a ref barra o segundo clique antes de a tela mudar). */
  async function act(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    handlers.current = {
      pause: (auto) => {
        if (phaseRef.current === "working" && abortRef.current) {
          abortRef.current.reason = auto ? "auto" : "manual";
          abortRef.current.controller.abort();
        } else if (phaseRef.current === "waiting") paused(auto);
      },
      resume: () => {
        if (phaseRef.current === "paused") void act(() => run((options) => runAgent(api, agentBridge, { message: "Pode continuar." }, options)));
      },
    };
  });

  async function send(message: string, kind?: AgentSessionKind) {
    const body = message.trim();
    if (!body) return;
    setText("");
    if (phaseRef.current === "support" && sessionRef.current) {
      try {
        const messages = await request<AgentSupportMessageDto[]>(`/agent/sessions/${sessionRef.current.id}/messages`, {
          method: "POST",
          body: { text: body },
        });
        queryClient.setQueryData(["agent-support", sessionRef.current.id], messages);
      } catch (error) {
        setText(body);
        push({
          kind: "agent",
          text: error instanceof ApiError ? error.message : "Não foi possível enviar. Tente de novo.",
        });
      }
      return;
    }
    push({ kind: "partner", text: body });
    try {
      if (!sessionRef.current) await startSession(kind ?? mode ?? (admin && SETUP_WORDS.test(body) ? "SETUP" : "SUPPORT"));
    } catch (error) {
      push({
        kind: "agent",
        text: error instanceof ApiError ? error.message : "Não consegui falar com o Dish Desk agora. Tente de novo.",
      });
      return;
    }
    await run((options) => runAgent(api, agentBridge, { message: body }, options));
  }

  async function startSupport() {
    try {
      await startSession("SUPPORT");
      push({
        kind: "agent",
        text: "Conte o que está acontecendo. Eu olho a sua tela e investigo com você.",
      });
      setPhase("waiting");
    } catch (error) {
      push({
        kind: "agent",
        text: error instanceof ApiError ? error.message : "Não consegui falar com o Dish Desk agora. Tente de novo.",
      });
    }
  }

  async function callSupport() {
    try {
      if (!sessionRef.current) await startSession("SUPPORT");
      finish(await request<AgentTurnDto>(`/agent/sessions/${sessionRef.current!.id}/handoff`, { method: "POST" }), null);
    } catch (error) {
      push({
        kind: "agent",
        text: error instanceof ApiError ? error.message : "Não foi possível chamar o suporte. Tente de novo.",
      });
    }
  }

  // Só o cartão mais recente responde (os de antes ficam como registro).
  const lastCard = entries.findLast((entry) => entry.kind === "card")?.id;
  const cardAction = (entry: Entry, work: () => Promise<void>) => () => {
    if (entry.id === lastCard && phaseRef.current !== "working") void act(work);
  };

  const current = progress ?? onboarding.data ?? null;
  const showProgress = mode === "SETUP" && current;
  const supportOpen = phase === "support" && !entries.some((entry) => entry.kind === "card" && entry.card.type === "off_hours");
  const status = statusOf(phase, supportOpen);
  const controls = sessionId && (phase === "working" || phase === "waiting" || phase === "paused");
  const agentName = support.findLast((message) => message.from === "support")?.author ?? null;

  return (
    <div className="flex h-full flex-col bg-paper">
      <Header
        mode={mode}
        status={status}
        controls={
          controls && (
            <>
              {phase === "paused" ? (
                <Button variant="outline" size="xs" onClick={() => handlers.current.resume()}>
                  <PlayIcon className="fill-current" aria-hidden />
                  Continuar
                </Button>
              ) : (
                <Button variant="outline" size="xs" onClick={() => handlers.current.pause(false)}>
                  <PauseIcon aria-hidden />
                  Pausar
                </Button>
              )}
              <Button variant="ghost" size="xs" onClick={stop}>
                <SquareIcon className="size-2.5 fill-current" aria-hidden />
                Parar
              </Button>
            </>
          )
        }
      />
      {showProgress && <Progress onboarding={current} />}

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-4">
        {phase === "done" && current ? (
          <Concluded onboarding={current} />
        ) : entries.length === 0 ? (
          <Welcome
            onboarding={admin ? (onboarding.data ?? null) : null}
            onSetup={() => act(() => send("Quero configurar o Dish Desk.", "SETUP"))}
            onHelp={() => act(startSupport)}
          />
        ) : (
          <div className="mt-auto flex flex-col gap-2.5">
            {entries.map((entry) => (
              <EntryView
                key={entry.id}
                entry={entry}
                active={entry.id === lastCard && phase !== "working" && !busy}
                cardAction={cardAction}
                handlers={{
                  confirm: (action, confirmed) => {
                    if (confirmed) push({ kind: "action", action, state: "running" });
                    return run((options) => answerConfirmation(api, agentBridge, action, confirmed, options));
                  },
                  permission: (host, granted) =>
                    run((options) =>
                      granted
                        ? answerPermission(api, agentBridge, host, options)
                        : runAgent(api, agentBridge, { message: `Não permiti agir em ${host}.` }, options),
                    ),
                  message: (message) => run((options) => runAgent(api, agentBridge, { message }, options)),
                  support: callSupport,
                }}
              />
            ))}
            {support.map((message) =>
              message.from === "partner" ? (
                <Bubble key={message.id} from="partner">
                  {message.text}
                </Bubble>
              ) : (
                <SupportBubble key={message.id} author={message.author} text={message.text} />
              ),
            )}
          </div>
        )}
        {!extensionPanel() && (
          <p className="mt-4 text-center text-[11px] text-ink-3">Abra este assistente pelo ícone da extensão do Dish Desk no Chrome.</p>
        )}
      </div>

      <Composer
        value={text}
        onChange={setText}
        disabled={phase === "unavailable"}
        sending={phase === "working" || busy}
        placeholder={
          phase === "support"
            ? agentName
              ? `Escreva para ${agentName.split(" ")[0]}…`
              : "Deixe a sua mensagem…"
            : "Peça em linguagem natural: conecta o meu WhatsApp…"
        }
        onSend={() => act(() => send(text))}
      />
    </div>
  );
}

type Status = { label: string; tone: "working" | "waiting" | "ok" | "off" };

function statusOf(phase: Phase, supportOpen: boolean): Status {
  if (phase === "working") return { label: "Trabalhando", tone: "working" };
  if (phase === "waiting") return { label: "Esperando você", tone: "waiting" };
  if (phase === "paused") return { label: "Pausada", tone: "off" };
  if (phase === "support") return supportOpen ? { label: "Com o suporte", tone: "ok" } : { label: "Esperando você", tone: "waiting" };
  if (phase === "unavailable") return { label: "IA indisponível", tone: "off" };
  if (phase === "done") return { label: "Concluído", tone: "ok" };
  return { label: "Pronta para ajudar", tone: "ok" };
}

const MODE_LABEL: Record<AgentSessionKind, string> = {
  SETUP: "Implantação",
  SUPPORT: "Suporte",
};

function Header({ mode, status, controls }: { mode: AgentSessionKind | null; status: Status; controls?: ReactNode }) {
  return (
    <header className="shrink-0 border-b border-rule bg-surface px-3.5 pt-3 pb-2.5">
      <div className="flex items-center gap-2">
        <LogoMark className="size-[22px] rounded-[5px] [&_svg]:size-3" />
        <span className="font-heading text-[15px] font-bold tracking-[-0.3px]">Dish Desk</span>
        {status.label !== "Desconectado" && (
          <span className="rounded-sm border border-rule bg-surface-2 px-1.5 py-px text-[10.5px] font-medium text-ink-2">
            {mode ? MODE_LABEL[mode] : "Início"}
          </span>
        )}
      </div>
      <div className="mt-2 flex min-h-[26px] items-center gap-1.5">
        <span
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            status.tone === "working" && "bg-tomate ring-3 ring-tomate/20",
            status.tone === "waiting" && "bg-warning",
            status.tone === "ok" && "bg-success",
            status.tone === "off" && "bg-ink-3",
          )}
          aria-hidden
        />
        <span
          role="status"
          className={cn(
            "text-[12px]",
            status.tone === "working" && "text-tomate",
            status.tone === "waiting" && "text-warning",
            status.tone === "ok" && "text-success",
            status.tone === "off" && "text-ink-2",
          )}
        >
          {status.label}
        </span>
        <span className="ml-auto flex items-center gap-1">{controls}</span>
      </div>
    </header>
  );
}

/** Progresso da implantação: recolhido, a barra e o passo atual; aberto, todos os passos. */
function Progress({ onboarding }: { onboarding: OnboardingDto }) {
  const [open, setOpen] = useState(false);
  const done = doneCount(onboarding);
  const total = onboarding.steps.length;
  const current = onboarding.steps[resumeIndex(onboarding)]!;
  return (
    <div className="shrink-0 border-b border-rule bg-surface-2/60">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left">
        <span className="h-1 w-[70px] overflow-hidden rounded-full bg-rule">
          <span className="block h-full rounded-full bg-tomate" style={{ width: `${(done / total) * 100}%` }} />
        </span>
        <span className="text-[11.5px] text-ink-2 tabular-nums">
          {done} de {total}
        </span>
        <span className="truncate text-[11.5px] text-ink-3">· {STEP_INFO[current.step].label}</span>
        {open ? (
          <ChevronUpIcon className="ml-auto size-3.5 text-ink-3" aria-hidden />
        ) : (
          <ChevronDownIcon className="ml-auto size-3.5 text-ink-3" aria-hidden />
        )}
      </button>
      {open && (
        <ul className="flex flex-col gap-1.5 px-3.5 pb-3">
          {onboarding.steps.map((item) => (
            <li key={item.step} className="flex items-center gap-2 text-[12px]">
              {item.status === "done" ? (
                <span className="flex size-4 items-center justify-center rounded-full bg-success text-white">
                  <CheckIcon className="size-2.5" aria-label="Feito" />
                </span>
              ) : item.status === "in_progress" ? (
                <LoaderCircleIcon className="size-4 text-tomate" aria-label="Em andamento" />
              ) : item.status === "error" ? (
                <AlertTriangleIcon className="size-4 text-tomate" aria-label="Com erro" />
              ) : (
                <span className="size-4 rounded-full border border-rule bg-surface" aria-hidden />
              )}
              <span className={cn(item.step === current.step && "font-medium", item.status === "skipped" && "text-ink-3")}>
                {STEP_INFO[item.step].label}
              </span>
              {item.status === "skipped" && <span className="ml-auto text-[11px] text-ink-3">pulado</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Welcome({ onboarding, onSetup, onHelp }: { onboarding: OnboardingDto | null; onSetup: () => void; onHelp: () => void }) {
  return (
    <div className="mt-auto">
      <h1 className="font-heading text-[20px] font-bold tracking-[-0.3px]">Oi! Como posso ajudar?</h1>
      <p className="mt-1 text-[12.5px] text-ink-2">Eu mexo no navegador junto com você e mostro cada passo.</p>
      <div className="mt-4 flex flex-col gap-2">
        {onboarding && (
          <EntryButton icon={<SparklesIcon className="size-4 text-tomate" aria-hidden />} tile="bg-tomate-lt" onClick={onSetup}>
            <span className="block text-[13px] font-medium">Configurar o Dish Desk</span>
            <span className="block text-[11.5px] text-ink-3">
              {doneCount(onboarding)} de {onboarding.steps.length} passos feitos
            </span>
          </EntryButton>
        )}
        <EntryButton icon={<MessageSquareIcon className="size-4 text-ink-2" aria-hidden />} tile="bg-surface-2" onClick={onHelp}>
          <span className="block text-[13px] font-medium">Preciso de ajuda</span>
          <span className="block text-[11.5px] text-ink-3">Dúvidas e problemas no Dish Desk</span>
        </EntryButton>
      </div>
    </div>
  );
}

function EntryButton({ icon, tile, onClick, children }: { icon: ReactNode; tile: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-xl border border-rule bg-surface px-3 py-3 text-left hover:bg-paper"
    >
      <span className={cn("flex size-[34px] shrink-0 items-center justify-center rounded-lg", tile)}>{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      <ArrowRightIcon className="size-3.5 text-ink-3" aria-hidden />
    </button>
  );
}

type EntryHandlers = {
  confirm: (action: AgentPageAction, confirmed: boolean) => Promise<void>;
  permission: (host: string, granted: boolean) => Promise<void>;
  message: (message: string) => Promise<void>;
  support: () => Promise<void>;
};

function EntryView({
  entry,
  active,
  cardAction,
  handlers,
}: {
  entry: Entry;
  active: boolean;
  cardAction: (entry: Entry, work: () => Promise<void>) => () => void;
  handlers: EntryHandlers;
}) {
  if (entry.kind === "partner") return <Bubble from="partner">{entry.text}</Bubble>;
  if (entry.kind === "agent") return <Bubble from="agent">{entry.text}</Bubble>;
  if (entry.kind === "action") return <ActionLine action={entry.action} state={entry.state} />;

  const card = entry.card;
  const on = (work: () => Promise<void>) => cardAction(entry, work);
  switch (card.type) {
    case "confirm":
      return (
        <>
          <Bubble from="agent">{card.say}</Bubble>
          <CardBox tone="strong" icon={<MousePointerClickIcon aria-hidden />} title="Confirmar ação">
            {describeAction(card.action, true)}
            {active && (
              <CardButtons>
                <Button size="xs" onClick={on(() => handlers.confirm(card.action, true))}>
                  Confirmar
                </Button>
                <Button variant="outline" size="xs" onClick={on(() => handlers.confirm(card.action, false))}>
                  Não fazer
                </Button>
              </CardButtons>
            )}
          </CardBox>
        </>
      );
    case "your_turn":
      return (
        <CardBox tone="warning" icon={<LockIcon aria-hidden />} title="Sua vez">
          {card.say} Eu não vejo o que você digita.
          {active && (
            <CardButtons>
              <Button size="xs" onClick={on(() => handlers.message("Pronto, terminei."))}>
                Pronto
              </Button>
            </CardButtons>
          )}
        </CardBox>
      );
    case "permission":
      return (
        <CardBox tone="strong" icon={<GlobeIcon aria-hidden />} title="Abrir outro site?">
          Este site não está na lista em que eu posso agir.
          <span className="mt-2 block rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px] break-all text-ink">{card.host}</span>
          {active && (
            <CardButtons>
              <Button size="xs" onClick={on(() => handlers.permission(card.host, true))}>
                Permitir
              </Button>
              <Button variant="outline" size="xs" onClick={on(() => handlers.permission(card.host, false))}>
                Não permitir
              </Button>
            </CardButtons>
          )}
        </CardBox>
      );
    case "paused":
      return (
        <CardBox tone="muted" icon={<PauseIcon aria-hidden />} title="Pausada. Você está no controle.">
          {card.auto ? "Pausei porque você começou a usar a página. Continuo de onde parei." : "Continuo de onde parei quando você quiser."}
          {active && (
            <CardButtons>
              <Button size="xs" onClick={on(() => handlers.message("Pode continuar."))}>
                <PlayIcon className="fill-current" aria-hidden />
                Continuar
              </Button>
            </CardButtons>
          )}
        </CardBox>
      );
    case "lost":
      return (
        <CardBox tone="danger" icon={<AlertTriangleIcon aria-hidden />} title="Não consegui continuar">
          {card.say}
          {active && (
            <CardButtons>
              <Button size="xs" onClick={on(() => handlers.message("Tente de novo."))}>
                Tentar de novo
              </Button>
              <Button variant="outline" size="xs" onClick={on(handlers.support)}>
                Falar com o suporte
              </Button>
            </CardButtons>
          )}
        </CardBox>
      );
    case "step_done":
      return (
        <CardBox tone="success" icon={<CheckIcon aria-hidden />} title={`${STEP_INFO[card.step].label} conectado`}>
          Conferido pelo Dish Desk.
          {card.step === "cardapio_web" && " Os clientes da loja estão sendo importados para Clientes, sem duplicar."}
          {card.next && ` Próximo passo: ${STEP_INFO[card.next].next}.`}
          {active && card.next && (
            <CardButtons>
              <Button size="xs" onClick={on(() => handlers.message("Pode seguir para o próximo passo."))}>
                Continuar
              </Button>
            </CardButtons>
          )}
        </CardBox>
      );
    case "handoff":
      return (
        <CardBox tone="muted" icon={<UserIcon aria-hidden />} title="Transferido para o suporte">
          Chamamos alguém da equipe Dish Desk. Ela já recebeu o histórico da conversa e das ações.
        </CardBox>
      );
    case "off_hours":
      return (
        <CardBox tone="muted" icon={<ClockIcon aria-hidden />} title={`O suporte volta ${card.when}`}>
          Deixe a sua mensagem aqui. A equipe já recebeu o histórico e responde assim que voltar.
        </CardBox>
      );
    case "unavailable":
      return (
        <CardBox tone="muted" icon={<AlertTriangleIcon aria-hidden />} title="A IA está fora do ar agora">
          Não consigo mexer no navegador neste momento. A equipe de suporte pode ajudar você.
          {active && (
            <CardButtons>
              <Button size="xs" onClick={on(handlers.support)}>
                Falar com o suporte
              </Button>
            </CardButtons>
          )}
        </CardBox>
      );
  }
}

function Bubble({ from, children }: { from: "partner" | "agent"; children: ReactNode }) {
  if (from === "partner") {
    return (
      <div className="max-w-[85%] self-end rounded-[12px_12px_2px_12px] bg-ink px-3 py-2 text-[13px] leading-[1.4] break-words whitespace-pre-wrap text-paper">
        {children}
      </div>
    );
  }
  return (
    <div className="flex max-w-[88%] items-start gap-2">
      <LogoMark className="mt-0.5 size-5 rounded-[5px] [&_svg]:size-3" />
      <div className="rounded-[12px_12px_12px_2px] border border-rule bg-surface px-3 py-2 text-[13px] leading-[1.4] break-words whitespace-pre-wrap">
        {children}
      </div>
    </div>
  );
}

function SupportBubble({ author, text }: { author: string | null; text: string }) {
  const initials = (author ?? "Suporte")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="flex max-w-[88%] items-start gap-2">
      <span className="mt-4 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#E9E3F5] text-[8.5px] font-semibold text-[#5B3FA0]">
        {initials}
      </span>
      <div>
        <p className="mb-1 text-[11px] font-medium text-ink-2">{author ?? "Equipe"} · Suporte Dish Desk</p>
        <div className="rounded-[12px_12px_12px_2px] border border-rule bg-surface px-3 py-2 text-[13px] leading-[1.4] break-words whitespace-pre-wrap">
          {text}
        </div>
      </div>
    </div>
  );
}

/** O que a IA faz na página: o endereço que abre ou o elemento em que clica, preenche ou escolhe. */
function describeAction(action: AgentPageAction, future = false): ReactNode {
  if (action.type === "navigate") {
    let host = action.url;
    try {
      host = new URL(action.url).hostname;
    } catch {
      // endereço inválido: mostra como veio
    }
    const name = HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? host;
    return future ? `Abrir ${name}.` : `Abrindo ${name}`;
  }
  const label = <b className="font-semibold">{action.label}</b>;
  if (action.type === "click")
    return future ? <>Clicar em {label}. Isso fala em nome do restaurante e não dá para desfazer.</> : <>Clicando em {label}</>;
  if (action.type === "fill") return future ? <>Preencher {label}.</> : <>Preenchendo {label}</>;
  return future ? (
    <>
      Escolher <b className="font-semibold">{action.value}</b> em {label}.
    </>
  ) : (
    <>
      Escolhendo <b className="font-semibold">{action.value}</b> em {label}
    </>
  );
}

function ActionLine({ action, state }: { action: AgentPageAction; state: "running" | "done" | "failed" }) {
  return (
    <div className="ml-[9px] flex items-center gap-2 border-l border-rule py-1 pl-4 text-[12px]">
      {state === "running" ? (
        <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-tomate" aria-label="Em andamento" />
      ) : state === "done" ? (
        <CheckIcon className="size-3 shrink-0 text-ink-3" aria-label="Feita" />
      ) : (
        <XIcon className="size-3 shrink-0 text-tomate" aria-label="Falhou" />
      )}
      <span className={cn("min-w-0", state === "failed" ? "text-tomate" : "text-ink-2")}>{describeAction(action)}</span>
    </div>
  );
}

const CARD_TONE = {
  strong: "border-[1.5px] border-ink bg-surface",
  warning: "border border-warning-line bg-warning-lt [&_h3]:text-warning",
  muted: "border border-rule bg-surface-2",
  danger: "border border-tomate-line bg-tomate-lt [&_h3]:text-tomate",
  success: "border border-success-line bg-success-lt [&_h3]:text-success-ink",
};

function CardBox({ tone, icon, title, children }: { tone: keyof typeof CARD_TONE; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className={cn("rounded-xl px-3.5 py-3", CARD_TONE[tone])}>
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold [&_svg]:size-3.5">
        {icon}
        {title}
      </h3>
      <div className="mt-1 text-[12.5px] leading-normal text-ink-2">{children}</div>
    </section>
  );
}

function CardButtons({ children }: { children: ReactNode }) {
  return <div className="mt-2.5 flex gap-1.5">{children}</div>;
}

/** Implantação concluída: o que foi feito e o que ficou de fora (dá para ligar em Configurações). */
function Concluded({ onboarding }: { onboarding: OnboardingDto }) {
  const steps = onboarding.steps;
  const skipped = steps.filter((item) => item.status === "skipped").length;
  const settings = steps.filter((item) => !(item.step in ONBOARDING_INTEGRATIONS) && item.step !== "first_message");
  const rows = [
    ...steps
      .filter((item) => item.step in ONBOARDING_INTEGRATIONS)
      .map((item) => ({
        label: STEP_INFO[item.step].label,
        done: item.status === "done",
      })),
    {
      label: "Horário, personalidade, links e equipe",
      done: settings.every((item) => item.status === "done"),
    },
  ];
  return (
    <div className="my-auto">
      <span className="flex size-[52px] items-center justify-center rounded-full bg-success text-white">
        <CheckIcon className="size-6" aria-hidden />
      </span>
      <h1 className="mt-4 font-heading text-[20px] font-bold tracking-[-0.3px]">Implantação concluída</h1>
      <p className="mt-1 text-[12.5px] leading-normal text-ink-2">
        {steps.length - skipped} {steps.length - skipped === 1 ? "passo feito" : "passos feitos"} e {skipped} {skipped === 1 ? "pulado" : "pulados"}.
        Dá para ligar o que ficou de fora em Configurações.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.label} className={cn("flex items-center gap-2 text-[12.5px]", !row.done && "text-ink-3")}>
            {row.done ? <CheckIcon className="size-3.5 text-ink-2" aria-hidden /> : <SkipForwardIcon className="size-3 text-ink-3" aria-hidden />}
            {row.label}
          </li>
        ))}
      </ul>
      <Button variant="accent" className="mt-5" onClick={() => window.open(`${window.location.origin}/inbox`, "_blank")}>
        Abrir a Inbox
      </Button>
    </div>
  );
}

function Composer({
  value,
  onChange,
  disabled,
  sending,
  placeholder,
  onSend,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  onSend: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!sending && value.trim()) onSend();
    }
  };
  return (
    <div className="flex shrink-0 items-end gap-2 border-t border-rule bg-surface px-3.5 py-3">
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        aria-label="Mensagem para o assistente"
        placeholder={placeholder}
        className="min-h-[52px] flex-1 resize-none rounded-lg border border-rule bg-paper px-3 py-2 text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink focus:ring-3 focus:ring-ink/8 disabled:bg-surface-2"
      />
      <Button variant="accent" size="icon-sm" aria-label="Enviar" disabled={disabled || sending || !value.trim()} onClick={onSend}>
        {sending ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <ArrowRightIcon aria-hidden />}
      </Button>
    </div>
  );
}
