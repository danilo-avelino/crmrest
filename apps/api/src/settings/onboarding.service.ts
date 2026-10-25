import type { Prisma, TenantTx } from "@dishdesk/database";
import {
  type MessageContent,
  ONBOARDING_INTEGRATIONS,
  ONBOARDING_STEPS,
  type OnboardingDto,
  type OnboardingMark,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingStepDto,
  onboardingStateOf,
  orderLinksOf,
} from "@dishdesk/shared";
import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { preview } from "../conversations/conversation.mapper.js";
import { DatabaseService } from "../core/database.service.js";
import { requireTenantAdmin } from "./tenant-admin.js";

/** O que o admin pode marcar em cada tipo de passo: integração (pular, em andamento) ou configuração (pular, manter o padrão). */
const INTEGRATION_MARKS: OnboardingMark[] = ["skipped", "in_progress"];
const SETTING_MARKS: OnboardingMark[] = ["skipped", "confirmed"];

const isIntegration = (step: OnboardingStep): step is keyof typeof ONBOARDING_INTEGRATIONS => step in ONBOARDING_INTEGRATIONS;
const hasKey = (settings: unknown, key: string) => !!settings && typeof settings === "object" && key in settings;

/**
 * Assistente de configuração (E30): o progresso vem do que o restaurante já tem (integrações conectadas, configurações
 * salvas, a primeira mensagem de um cliente); em `tenant.settings.onboarding` fica só o que o admin respondeu (pulou,
 * manteve o padrão, ficou esperando um terceiro) e se ele já abriu o assistente. Só o admin vê e altera.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly db: DatabaseService) {}

  get(auth: RequestAuth, tenantId: string): Promise<OnboardingDto> {
    requireTenantAdmin(auth, tenantId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) => onboardingOf(tx, tenantId));
  }

  async mark(auth: RequestAuth, tenantId: string, step: OnboardingStep, mark: OnboardingMark | null): Promise<OnboardingDto> {
    if (mark && !(isIntegration(step) ? INTEGRATION_MARKS : step === "first_message" ? [] : SETTING_MARKS).includes(mark)) {
      throw new UnprocessableEntityException("Este passo não aceita essa resposta.");
    }
    return this.update(auth, tenantId, (state) => {
      const { [step]: _, ...marks } = state.marks ?? {};
      return { ...state, marks: mark ? { ...marks, [step]: mark } : marks };
    });
  }

  /** O admin abriu o assistente: ele não abre mais sozinho (continua pelo aviso na Inbox e por Configurações). */
  opened(auth: RequestAuth, tenantId: string): Promise<OnboardingDto> {
    return this.update(auth, tenantId, (state) => ({ ...state, openedAt: state.openedAt ?? new Date().toISOString() }));
  }

  private update(auth: RequestAuth, tenantId: string, change: (state: OnboardingState) => OnboardingState): Promise<OnboardingDto> {
    requireTenantAdmin(auth, tenantId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const { settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: { ...current, onboarding: change(onboardingStateOf(current)) } as Prisma.InputJsonObject },
      });
      return onboardingOf(tx, tenantId);
    });
  }
}

/** O progresso do assistente. Também serve ao agente da extensão (E31), que segue os mesmos passos. */
export async function onboardingOf(tx: TenantTx, tenantId: string): Promise<OnboardingDto> {
  const { settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
  const channels = await tx.channel.findMany({
    where: { tenantId, deletedAt: null, type: { in: Object.values(ONBOARDING_INTEGRATIONS) } },
    select: { type: true, name: true, status: true },
    orderBy: { id: "asc" }, // UUIDv7: a ordem em que foram conectados
  });
  const members = await tx.tenantMember.count({ where: { tenantId, isActive: true } });
  const firstMessage = await tx.message.findFirst({
    where: { tenantId, direction: "INBOUND" },
    orderBy: { createdAt: "asc" },
    select: { type: true, content: true, createdAt: true, channel: { select: { type: true } } },
  });
  const state = onboardingStateOf(settings);

  const saved: Record<Exclude<OnboardingStep, keyof typeof ONBOARDING_INTEGRATIONS | "first_message">, boolean> = {
    business_hours: hasKey(settings, "businessHours"),
    personality: hasKey(settings, "personality"),
    order_links: orderLinksOf(settings).length > 0,
    members: members > 1,
  };
  const steps = ONBOARDING_STEPS.map((step): OnboardingStepDto => {
    const mark = state.marks?.[step];
    if (step === "first_message") return { step, status: firstMessage ? "done" : "todo", detail: null };
    if (isIntegration(step)) {
      const ofType = channels.filter((channel) => channel.type === ONBOARDING_INTEGRATIONS[step]);
      const connected = ofType.find((channel) => channel.status === "CONNECTED");
      if (connected) return { step, status: "done", detail: connected.name };
      const failing = ofType.find((channel) => channel.status === "ERROR");
      if (failing) return { step, status: "error", detail: failing.name };
      return { step, status: mark === "skipped" ? "skipped" : mark === "in_progress" ? "in_progress" : "todo", detail: null };
    }
    if (saved[step] || mark === "confirmed") return { step, status: "done", detail: null };
    return { step, status: mark === "skipped" ? "skipped" : "todo", detail: null };
  });
  const completed = steps.every((item) => item.status !== "todo" && item.status !== "error");
  return {
    tenantId,
    steps,
    firstMessage: firstMessage && {
      text: preview(firstMessage.type, firstMessage.content as MessageContent),
      channelType: firstMessage.channel.type,
      at: firstMessage.createdAt.toISOString(),
    },
    completed,
    autoOpen: !state.openedAt && !completed,
  };
}
