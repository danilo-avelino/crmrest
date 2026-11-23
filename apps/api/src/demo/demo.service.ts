import { randomInt, randomUUID } from "node:crypto";
import { DEMO_USERS, type DemoSummary, type DemoUserKey, parseEncryptionKey, type Prisma, seedDemoData, wipeDemoData } from "@dishdesk/database";
import { COURIER_TAG, type MessageContent, STAFF_TAG } from "@dishdesk/shared";
import { ForbiddenException, Inject, Injectable, Logger, type OnModuleDestroy, UnprocessableEntityException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { DEMO_SCRIPTS, type DemoScenario, type DemoStep } from "./demo-scripts.js";
import { isDemoTenant } from "./demo.js";

const MINUTE = 60_000;
/** O reset apaga e recria umas 6 mil linhas numa transação: mais tempo que o padrão. */
const RESET_TIMEOUT_MS = 180_000;

type Simulation = { tenantId: string; conversationId: string; channelId: string; from: string; orderId: string | null; vars: Record<string, string> };

/**
 * Conta de demonstração: o reset (botão escondido e todo dia às 5h) e a simulação de clientes escrevendo durante a
 * apresentação. A simulação grava as mensagens direto no banco e avisa o painel pelo realtime, como uma conversa de
 * verdade, sem passar por canal, automação ou IA (nada sai do Dish Desk).
 */
@Injectable()
export class DemoService implements OnModuleDestroy {
  private readonly logger = new Logger(DemoService.name);
  private readonly key: Buffer;
  /** Passos agendados das simulações, por restaurante (o reset cancela os que ainda não rodaram). */
  private readonly timers = new Map<string, Set<NodeJS.Timeout>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @Inject(ENV) env: Env,
  ) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
  }

  onModuleDestroy(): void {
    for (const set of this.timers.values()) for (const timer of set) clearTimeout(timer);
  }

  /** Só quem é do restaurante, e só se ele for a demo. */
  private async requireDemo(auth: RequestAuth, tenantId: string): Promise<void> {
    if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException();
    if (!(await isDemoTenant(this.db, tenantId))) throw new ForbiddenException("Só a conta de demonstração tem esta ação.");
  }

  async reset(auth: RequestAuth, tenantId: string): Promise<DemoSummary> {
    await this.requireDemo(auth, tenantId);
    return this.resetTenant(tenantId);
  }

  /** Todo dia às 5h: as demos voltam ao estado inicial, com as datas de hoje. */
  async resetAll(): Promise<void> {
    const tenants = await this.db.client.$queryRaw<{ id: string }[]>`SELECT id FROM app.active_tenants()`;
    for (const { id } of tenants) {
      if (!(await isDemoTenant(this.db, id))) continue;
      try {
        await this.resetTenant(id);
      } catch (error) {
        this.logger.warn({ tenantId: id, err: error }, "Reset diário da demo falhou");
      }
    }
  }

  async resetTenant(tenantId: string): Promise<DemoSummary> {
    for (const timer of this.timers.get(tenantId) ?? []) clearTimeout(timer);
    this.timers.delete(tenantId);
    const scope = { tenantIds: [tenantId] };
    const members = await this.db.withTenants(scope, (tx) =>
      tx.tenantMember.findMany({ where: { tenantId }, select: { userId: true, role: true, user: { select: { email: true } } } }),
    );
    // Cada papel do roteiro com o login da demo de mesmo e-mail; sem ele, o primeiro administrador.
    const fallback = members.find((member) => member.role === "ADMIN")?.userId ?? members[0]?.userId;
    if (!fallback) throw new UnprocessableEntityException("A demo não tem usuários: rode pnpm demo:reset.");
    const users = Object.fromEntries(
      DEMO_USERS.map((user) => [user.key, members.find((member) => member.user.email === user.email)?.userId ?? fallback]),
    ) as Record<DemoUserKey, string>;
    // As configurações do restaurante só mudam com um administrador na sessão (RLS): o reset age como o admin da demo.
    const summary = await this.db.withTenants(
      { ...scope, userId: users.admin },
      async (tx) => {
        await wipeDemoData(tx, tenantId);
        return seedDemoData(tx, { tenantId, users, key: this.key });
      },
      { timeout: RESET_TIMEOUT_MS },
    );
    this.realtime.inboxChanged(tenantId, randomUUID());
    this.realtime.ordersChanged(tenantId);
    this.logger.log(`Demo ${tenantId} resetada: ${summary.conversations} conversas, ${summary.orders} pedidos`);
    return summary;
  }

  /** Um cliente novo começa a escrever; as respostas seguem o roteiro, no ritmo de uma conversa de verdade. */
  async simulate(auth: RequestAuth, tenantId: string, scenario: DemoScenario): Promise<{ conversationId: string }> {
    await this.requireDemo(auth, tenantId);
    const script = DEMO_SCRIPTS[scenario];
    const now = new Date();
    const simulation = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const channels = await tx.channel.findMany({ where: { tenantId, deletedAt: null, type: { in: ["WHATSAPP", "IFOOD"] } }, select: { id: true, type: true } });
      const whatsapp = channels.find((channel) => channel.type === "WHATSAPP");
      const ifood = channels.find((channel) => channel.type === "IFOOD");
      if (!whatsapp) throw new UnprocessableEntityException("A demo está sem o WhatsApp: use Resetar demo.");
      // Telefone fictício na faixa da demo (+55 11 90000-6xxx a 8xxx).
      const phone = `+551190000${randomInt(6000, 9000)}`;
      const contact = await tx.contact.create({
        data: {
          tenantId,
          name: script.name,
          phone,
          phoneSource: "channel",
          phoneStatus: "ok",
          tags: script.courier ? [COURIER_TAG] : [],
          lastSeenAt: now,
          identities: { create: { tenantId, channelType: "WHATSAPP", externalId: phone.slice(1), profile: { name: script.name } } },
        },
        select: { id: true },
      });
      let order: { id: string; displayCode: string | null } | null = null;
      if (script.order && ifood) {
        // O entregador leva o pedido de um cliente que já existe; o cliente que pergunta, o dele.
        const customer = script.courier
          ? await tx.contact.findFirst({ where: { tenantId, phone: { not: null }, NOT: { tags: { hasSome: [COURIER_TAG, STAFF_TAG] } }, id: { not: contact.id } }, orderBy: { lastSeenAt: "desc" }, select: { id: true } })
          : contact;
        order = await this.createOrder(tx, { tenantId, channelId: ifood.id, contactId: (customer ?? contact).id, dispatched: Boolean(script.courier), now });
      }
      const conversation = await tx.conversation.create({
        data: {
          tenantId,
          contactId: contact.id,
          channelId: whatsapp.id,
          status: "OPEN",
          lastMessageAt: now,
          windowExpiresAt: new Date(now.getTime() + 24 * 60 * MINUTE),
          automationState: script.courier && order ? { courierOrderId: order.id } : {},
        },
        select: { id: true },
      });
      if (order && !script.courier) await tx.order.update({ where: { id: order.id }, data: { conversationId: conversation.id } });
      const hora = new Date(now.getTime() + 25 * MINUTE).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
      return {
        tenantId,
        conversationId: conversation.id,
        channelId: whatsapp.id,
        from: phone.slice(1),
        orderId: order && !script.courier ? order.id : null,
        vars: { nome: script.name.split(" ")[0]!, pedido: order?.displayCode ?? "", hora },
      } satisfies Simulation;
    });
    if (script.order) this.realtime.ordersChanged(tenantId);

    let delay = 0;
    for (const [index, step] of script.steps.entries()) {
      delay += step.after * 1000;
      this.later(tenantId, delay, () => this.play(simulation, step, index === 0));
    }
    return { conversationId: simulation.conversationId };
  }

  private later(tenantId: string, delay: number, run: () => Promise<void>): void {
    const set = this.timers.get(tenantId) ?? new Set();
    this.timers.set(tenantId, set);
    const timer = setTimeout(() => {
      set.delete(timer);
      // A conversa pode ter sumido num reset no meio da simulação: o passo só não acontece.
      run().catch((error: unknown) => this.logger.warn(`Passo da simulação não gravado: ${error instanceof Error ? error.message : String(error)}`));
    }, delay);
    set.add(timer);
  }

  /** Grava um passo do roteiro e avisa o painel. */
  private async play(simulation: Simulation, step: DemoStep, first: boolean): Promise<void> {
    const { tenantId, conversationId, channelId } = simulation;
    const text = step.text.replace(/\{(\w+)\}/g, (match, key: string) => simulation.vars[key] ?? match);
    await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const now = new Date();
      const base = { tenantId, conversationId, channelId, createdAt: now };
      const content: MessageContent =
        step.kind === "customer"
          ? { text, from: simulation.from }
          : step.kind === "ai"
            ? { text, aiReply: true }
            : step.kind === "automation"
              ? { text, automation: step.automation }
              : { event: step.kind, text };
      const inbound = step.kind === "customer";
      const system = step.kind === "handoff" || step.kind === "menu_agent";
      await tx.message.create({
        data: {
          ...base,
          direction: inbound ? "INBOUND" : system ? "INTERNAL" : "OUTBOUND",
          type: system ? "SYSTEM" : "TEXT",
          status: inbound ? "DELIVERED" : system ? null : "READ",
          content: content as Prisma.InputJsonObject,
        },
      });
      // O card do pedido logo depois da primeira mensagem do cliente.
      if (first && simulation.orderId) {
        await tx.message.create({
          data: { ...base, createdAt: new Date(now.getTime() + 1), direction: "INTERNAL", type: "SYSTEM", content: { event: "order", orderId: simulation.orderId } },
        });
      }
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: now,
          ...(inbound && { unreadCount: { increment: 1 }, windowExpiresAt: new Date(now.getTime() + 24 * 60 * MINUTE) }),
          ...(step.kind === "handoff" && { awaitingAgentSince: now }),
        },
      });
    });
    this.realtime.inboxChanged(tenantId, conversationId);
  }

  /** Pedido do iFood da simulação: em preparo (cliente perguntando) ou já com o entregador. */
  private async createOrder(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; channelId: string; contactId: string; dispatched: boolean; now: Date },
  ): Promise<{ id: string; displayCode: string | null }> {
    const { tenantId, channelId, contactId, dispatched, now } = input;
    const placedAt = new Date(now.getTime() - (dispatched ? 42 : 38) * MINUTE);
    const at = (minutes: number) => new Date(placedAt.getTime() + minutes * MINUTE);
    const code = String(5000 + (await tx.order.count({ where: { tenantId, channelId } })));
    const steps: [string, Date][] = [["PLACED", placedAt], ["CONFIRMED", at(2)], ...(dispatched ? ([["READY_TO_PICKUP", at(22)], ["DISPATCHED", at(28)]] as [string, Date][]) : [])];
    return tx.order.create({
      data: {
        tenantId,
        contactId,
        channelId,
        externalOrderId: `demo-sim-${randomUUID()}`,
        displayCode: code,
        status: dispatched ? "DISPATCHED" : "PREPARING",
        subtotal: "71.80",
        deliveryFee: "6.00",
        total: "77.80",
        placedAt,
        dispatchedAt: dispatched ? at(28) : null,
        deliveryAddress: { street: "Rua das Begônias", number: "128", district: "Vila Mariana", city: "São Paulo", state: "SP", complement: "ap. 32" },
        raw: {
          orderType: "DELIVERY",
          delivery: { deliveryDateTime: at(55).toISOString(), deliveredBy: "MERCHANT", pickupCode: String(randomInt(1000, 9999)) },
          payments: { methods: [{ method: "CREDIT", value: 77.8, prepaid: true, card: { brand: "VISA" } }] },
        },
        items: {
          create: [
            { tenantId, name: "Pizza Portuguesa grande", quantity: 1, unitPrice: "62.90" },
            { tenantId, name: "Guaraná Antarctica 2 L", quantity: 1, unitPrice: "8.90" },
          ],
        },
        events: { create: steps.map(([code, occurredAt]) => ({ tenantId, code, occurredAt, externalEventId: `demo-sim-${code}-${randomUUID()}` })) },
      },
      select: { id: true, displayCode: true },
    });
  }
}
