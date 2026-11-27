import { randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import { automationMessagesOf } from "@dishdesk/shared";
import { HttpException, HttpStatus, Inject, Injectable, type OnModuleDestroy, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { Redis } from "ioredis";
import { z } from "zod";
import type { LlmProvider } from "../ai/llm-provider.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { requireModule } from "../menu/menu.service.js";
import { AGENT_MAX_ITERATIONS, AGENT_TIMEOUT_MS, type HistoryMessage, ORDER_AGENT_LLM, OrderAgentService } from "./order-agent.service.js";

/** Simulações por restaurante por dia (cada uma chama o modelo de verdade e custa). */
export const SIMULATION_DAILY_LIMIT = 30;
export const SIMULATION_MAX_MESSAGES = 40;
const MESSAGE_MAX = 1_000;
/** Uma volta do agente (até 6 chamadas de 30 s) mais a nova tentativa da trava de preço, com folga. */
const TRANSACTION_TIMEOUT_MS = (AGENT_MAX_ITERATIONS + 2) * AGENT_TIMEOUT_MS;

const BRASILIA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });
export const simulationKey = (tenantId: string, now: Date) => `menu-agent:simulations:${tenantId}:${BRASILIA_DAY.format(now)}`;

/**
 * O carrinho da simulação, devolvido ao painel e reenviado no turno seguinte: como cada simulação é desfeita no fim,
 * é assim que o carrinho "continua" entre as mensagens do teste. Os ids são refeitos a cada volta.
 */
export const SimulationCart = z.object({
  status: z.enum(["DRAFT", "AWAITING_CONFIRMATION"]),
  deliveryAddress: z.record(z.string(), z.unknown()).nullable(),
  items: z
    .array(
      z.object({
        itemId: z.uuid(),
        sizeId: z.uuid().nullable(),
        halves: z.array(z.uuid()).max(5),
        options: z.array(z.object({ id: z.uuid(), groupId: z.uuid(), name: z.string().max(200), priceCents: z.number().int().min(0) })).max(50),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().max(500).nullable(),
      }),
    )
    .max(50),
});
export type SimulationCart = z.infer<typeof SimulationCart>;

export const SimulateAgentRequest = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(MESSAGE_MAX) }))
    .min(1)
    .max(SIMULATION_MAX_MESSAGES)
    .refine((messages) => messages.at(-1)?.role === "user", "A última mensagem precisa ser do cliente."),
  cart: SimulationCart.nullish(),
  /** As ofertas de venda já feitas nesta simulação (E48): voltam a cada turno, como o carrinho. */
  salesOffers: z.array(z.string().max(80)).max(20).optional(),
});
export type SimulateAgentRequest = z.infer<typeof SimulateAgentRequest>;

/** Lançado no fim da simulação para a transação desfazer tudo (carrinho, conversa e contato de mentira). */
class Rollback extends Error {
  constructor(readonly payload: unknown) {
    super("rollback da simulação");
  }
}

export type SimulationResult = {
  /** O texto que o cliente receberia (com as opções numeradas, se o agente ofereceu); null se o agente parou. */
  reply: string | null;
  /** Por que o agente parou (teto, falha, resposta inválida): na conversa real, a equipe seria chamada. */
  stopped: string | null;
  /** O agente chamou a equipe, com o motivo. */
  handoff: string | null;
  /** O que a equipe veria na conversa ("IA adicionou 1 Calabresa G"). */
  events: string[];
  toolCalls: { name: string; input: unknown; output: unknown; isError: boolean }[];
  cart: SimulationCart | null;
  salesOffers: string[];
};

/**
 * "Simular conversa" (Configurações → Pedidos pela IA): roda o mesmo agente de pedidos, com o cardápio e as
 * configurações reais do restaurante, numa transação que é desfeita no fim. Nada fica no banco (carrinho, conversa,
 * contato, pedido) e nada é enviado a cliente algum: só o uso da IA fica em AiUsage (gravado pelo provedor, fora da
 * transação). Limite de `SIMULATION_DAILY_LIMIT` por restaurante por dia.
 */
@Injectable()
export class AgentSimulatorService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    private readonly db: DatabaseService,
    private readonly agent: OrderAgentService,
    @Inject(ORDER_AGENT_LLM) private readonly llm: LlmProvider,
    @Inject(ENV) env: Env,
  ) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /** Há chave da API do Claude (sem ela a simulação responde 503). */
  get configured(): boolean {
    return this.llm.enabled;
  }

  async simulate(scope: { tenantIds: string[]; userId?: string }, tenantId: string, request: SimulateAgentRequest, now = new Date()): Promise<SimulationResult> {
    if (!this.llm.enabled) throw new ServiceUnavailableException("A IA não está configurada neste ambiente (falta a chave da API do Claude).");
    const key = simulationKey(tenantId, now);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 2 * 24 * 60 * 60);
    if (count > SIMULATION_DAILY_LIMIT) {
      throw new HttpException(`Limite de ${SIMULATION_DAILY_LIMIT} simulações por dia atingido. Volte amanhã.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      await this.db.withTenants(scope, (tx) => this.run(tx, tenantId, request, now), { timeout: TRANSACTION_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof Rollback) return error.payload as SimulationResult;
      // Recusa antes de chamar o modelo (módulo desligado, cardápio inativo): a simulação não conta no limite.
      if (error instanceof HttpException) await this.redis.decr(key);
      throw error;
    }
    throw new Error("a simulação precisa terminar em rollback");
  }

  /** Tudo o que a simulação grava fica nesta transação, que termina sempre com o `Rollback`. */
  private async run(tx: TenantTx, tenantId: string, request: SimulateAgentRequest, now: Date): Promise<never> {
    await requireModule(tx, tenantId);
    const [tenant, menu] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, settings: true } }),
      tx.menu.findUnique({ where: { tenantId }, select: { active: true } }),
    ]);
    if (!menu?.active) throw new UnprocessableEntityException("Publique o cardápio para simular: o agente atende pelo cardápio ativo.");

    // A conversa de mentira só existe nesta transação (o carrinho do agente é preso a uma conversa).
    const channel = await tx.channel.create({
      data: { tenantId, type: "WHATSAPP", name: "Simulação", externalId: `simulacao-${randomUUID()}`, credentials: Buffer.alloc(0), status: "CONNECTED" },
      select: { id: true },
    });
    const contact = await tx.contact.create({ data: { tenantId, name: "Cliente (simulação)" }, select: { id: true } });
    const conversation = await tx.conversation.create({
      data: { tenantId, contactId: contact.id, channelId: channel.id, status: "OPEN", automationState: { ai: "on" } },
      select: { id: true },
    });
    if (request.cart) await this.restoreCart(tx, tenantId, conversation.id, contact.id, request.cart, now);

    const history: HistoryMessage[] = request.messages.map((message) => ({
      direction: message.role === "user" ? "INBOUND" : "OUTBOUND",
      type: "TEXT",
      content: message.role === "user" ? { text: message.text } : { text: message.text, aiReply: true },
      sentByUserId: null,
    }));
    const outcome = await this.agent.converse({
      db: { withTenants: (_scope, fn) => fn(tx) },
      tenantId,
      tenantName: tenant.name,
      settings: tenant.settings,
      conversationId: conversation.id,
      contactId: contact.id,
      contactName: null,
      state: { aiReplies: request.messages.filter((message) => message.role === "assistant").length, salesOffers: request.salesOffers ?? [] },
      history,
      lastContent: { text: request.messages.at(-1)!.text },
      now,
      onUsage: () => undefined, // o uso da IA vai para AiUsage (pelo provedor); o teto por conversa não vale na simulação
      allowDemo: true, // nada sai da transação: a demo das apresentações também simula com a IA de verdade
    });
    const cart = await this.snapshotCart(tx, tenantId, conversation.id);
    const salesOffers = [...(request.salesOffers ?? []), ...(outcome.kind === "reply" ? outcome.salesOffered : [])];
    const toolCalls = outcome.kind === "reply" ? outcome.toolCalls.map(({ name, input, output, isError }) => ({ name, input, output, isError })) : [];
    const result: SimulationResult =
      outcome.kind === "reply"
        ? { reply: outcome.text || automationMessagesOf(tenant.settings).menuAgentHandoff, stopped: null, handoff: outcome.handoff, events: outcome.events, toolCalls, cart, salesOffers }
        : { reply: null, stopped: outcome.why, handoff: null, events: outcome.events, toolCalls, cart, salesOffers };
    throw new Rollback(result);
  }

  private async restoreCart(tx: TenantTx, tenantId: string, conversationId: string, contactId: string, cart: SimulationCart, now: Date) {
    // Só itens e tamanhos deste restaurante (um id de outro restaurante nunca entra no carrinho).
    const itemIds = [...new Set(cart.items.flatMap((item) => [item.itemId, ...item.halves]))];
    const sizeIds = [...new Set(cart.items.flatMap((item) => (item.sizeId ? [item.sizeId] : [])))];
    const [items, sizes] = await Promise.all([
      tx.menuItem.count({ where: { tenantId, id: { in: itemIds } } }),
      tx.menuItemSize.count({ where: { tenantId, id: { in: sizeIds } } }),
    ]);
    if (items !== itemIds.length || sizes !== sizeIds.length) {
      throw new UnprocessableEntityException("O carrinho da simulação tem item que não existe mais no cardápio. Reinicie a simulação.");
    }
    await tx.cart.create({
      data: {
        tenantId,
        contactId,
        conversationId,
        status: cart.status,
        ...(cart.deliveryAddress && { deliveryAddress: cart.deliveryAddress as object }),
        items: {
          // createdAt crescente: dentro da transação o now() do banco seria igual e o carrinho perderia a ordem.
          create: cart.items.map((item, index) => ({ tenantId, ...item, createdAt: new Date(now.getTime() + index) })),
        },
      },
      select: { id: true },
    });
  }

  private async snapshotCart(tx: TenantTx, tenantId: string, conversationId: string): Promise<SimulationCart | null> {
    const cart = await tx.cart.findFirst({
      where: { tenantId, conversationId, status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] } },
      orderBy: { createdAt: "desc" },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    if (!cart || cart.items.length === 0) return null;
    return SimulationCart.parse({
      status: cart.status,
      deliveryAddress: cart.deliveryAddress,
      items: cart.items.map((item) => ({ itemId: item.itemId, sizeId: item.sizeId, halves: item.halves, options: item.options, quantity: item.quantity, notes: item.notes })),
    });
  }
}
