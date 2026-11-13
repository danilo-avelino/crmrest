import { CHANNEL_LABEL, type DuplicateReason } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { JevClient, type JevQuestion } from "../defense/jev.client.js";
import { type DuplicateReviewJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { findDuplicatePairs } from "./contact-duplicates.js";
import { mergeContacts } from "./contact-merge.js";
import { refreshContactTags } from "./contact-tags.service.js";

/** Chance a partir da qual o Jev une sozinho um par com o mesmo telefone ou o mesmo CPF. */
export const SAME_PERSON_FROM = 0.9;
/** Só estes motivos deixam o Jev unir sem o admin: são dados do próprio cliente, não da casa ou do prédio. */
const STRONG_REASONS: DuplicateReason[] = ["phone", "cpf"];
/** Abaixo das respostas aos clientes na fila ai (jobs sem prioridade passam na frente). */
const PRIORITY = 10;

const REASON_TEXT: Record<DuplicateReason, string> = {
  phone: "mesmo telefone",
  cpf: "mesmo CPF",
  email: "mesmo e-mail",
  name: "mesmo nome completo",
  address: "mesmo endereço de entrega (rua, número, complemento e cidade)",
};

const SAME_PERSON: Record<"same", JevQuestion> = {
  same: {
    type: "noul",
    instructions:
      "Os dois cadastros são da mesma pessoa? Nomes diferentes que não sejam apelido, abreviação, nome incompleto ou o mesmo nome escrito de outro jeito indicam pessoas diferentes. Pessoas da mesma casa dividem o endereço, e parentes às vezes dividem o telefone ou o e-mail. Um cadastro sem nome não prova nada sozinho.",
  },
};

/**
 * O Jev revisa os possíveis duplicados antes de o admin vê-los: os que ele diz serem pessoas diferentes saem da fila;
 * os com o mesmo telefone ou CPF em que ele tem certeza são unidos sem o admin; o resto vai para a fila. De hora em hora
 * a varredura põe na fila ai um job por par ainda não revisado. Sem JEV_API_KEY, nada roda e a fila mostra todos os pares.
 * Vão ao Jev os nomes, os canais e os endereços; telefone, CPF e e-mail não vão, só se são iguais.
 */
@Injectable()
export class ContactDuplicateReviewService implements OnModuleInit {
  private readonly logger = new Logger(ContactDuplicateReviewService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jev: JevClient,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.ai) private readonly queue: Queue<DuplicateReviewJob>,
  ) {}

  async onModuleInit(): Promise<void> {
    // De hora em hora, fora da hora cheia (a das tags). Cron, e não `every`: o `every` roda também ao subir a API, e os
    // testes (no banco do dev) varreriam os restaurantes de verdade com o Jev falso.
    if (this.jev.enabled) await this.queue.upsertJobScheduler("duplicate-review-sweep", { pattern: "30 * * * *" }, { name: "duplicate-review-sweep" });
  }

  async sweep(): Promise<void> {
    if (!this.jev.enabled) return;
    const tenants = await this.db.client.$queryRaw<{ id: string }[]>`SELECT id FROM app.active_tenants()`;
    for (const { id: tenantId } of tenants) {
      try {
        await this.enqueue(tenantId);
      } catch (error) {
        // Segue para os outros restaurantes; a próxima hora tenta de novo.
        this.logger.warn({ tenantId, err: error }, "Possíveis duplicados não enviados ao Jev");
        Sentry.captureException(error, { tags: { tenantId } });
      }
    }
  }

  /** Um job por par do restaurante que o Jev ainda não revisou. */
  async enqueue(tenantId: string): Promise<void> {
    const pairs = await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => findDuplicatePairs(tx, "unreviewed"));
    // Um job repetido (a varredura anterior ainda na fila) não chama o Jev de novo: o par já tem revisão.
    await this.queue.addBulk(
      pairs.map((pair) => ({
        name: "duplicate-review",
        data: { tenantId, contactIds: [pair.a, pair.b], reasons: pair.reasons },
        opts: { priority: PRIORITY },
      })),
    );
  }

  /** Uma falha do Jev lança: o BullMQ tenta de novo, e o par fica fora da fila do admin até ser revisado. */
  async review({ tenantId, contactIds: [aId, bId], reasons }: DuplicateReviewJob): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const pair = await this.db.withTenants(scope, async (tx) => {
      const reviewed = await tx.contactDuplicateReview.findUnique({ where: { contactAId_contactBId: { contactAId: aId, contactBId: bId } } });
      if (reviewed && sameReasons(reviewed.reasons, reasons)) return null;
      const contacts = await tx.contact.findMany({
        where: { id: { in: [aId, bId] }, deletedAt: null },
        include: {
          identities: { select: { channelType: true } },
          addresses: { select: { street: true, number: true, complement: true, district: true, city: true } },
          _count: { select: { orders: true, conversations: true } },
        },
      });
      const [a, b] = [contacts.find((contact) => contact.id === aId), contacts.find((contact) => contact.id === bId)];
      return a && b ? { a, b } : null; // um dos dois já foi unido ou anonimizado
    });
    if (!pair) return;

    const { a, b } = pair;
    const side = (contact: typeof a) => ({
      nome: contact.name,
      canais: [...new Set(contact.identities.map((identity) => CHANNEL_LABEL[identity.channelType]))],
      enderecos: contact.addresses.map((address) =>
        [[address.street, address.number].filter(Boolean).join(", "), address.complement, address.district, address.city].filter(Boolean).join(" · "),
      ),
      pedidos: contact._count.orders,
      conversas: contact._count.conversations,
      cliente_desde: contact.firstSeenAt.toISOString().slice(0, 7),
    });
    const both = (x: string | null, y: string | null) => (x && y ? (x.toLowerCase() === y.toLowerCase() ? "sim" : "não") : "um dos cadastros não tem");
    const { answers, model } = await this.jev.decide(
      tenantId,
      {
        como_ler: "Dois cadastros de clientes do mesmo restaurante, que o sistema achou parecidos pelos motivos listados.",
        motivos: reasons.map((reason) => REASON_TEXT[reason]),
        mesmo_telefone: both(a.phone, b.phone),
        mesmo_cpf: both(a.cpfHash, b.cpfHash),
        mesmo_email: both(a.email, b.email),
        cadastro_1: side(a),
        cadastro_2: side(b),
      },
      SAME_PERSON,
      { privateData: true },
    );
    if (answers.same.type !== "noul") throw new Error("O Jev recusou revisar o possível duplicado.");
    const sameChance = answers.same.noul;

    const merge = sameChance >= SAME_PERSON_FROM && reasons.some((reason) => STRONG_REASONS.includes(reason));
    const changed = await this.db.withTenants(scope, async (tx) => {
      const data = { reasons, sameChance, model };
      await tx.contactDuplicateReview.upsert({
        where: { contactAId_contactBId: { contactAId: aId, contactBId: bId } },
        create: { tenantId, contactAId: aId, contactBId: bId, ...data },
        update: { ...data, createdAt: new Date() },
      });
      if (!merge) return null;
      const result = await mergeContacts(tx, a, b, undefined, { by: "jev", sameChance, model });
      if (!result.merged) return null;
      await refreshContactTags(tx); // os pedidos dos dois cadastros agora são de um só
      return tx.conversation.findMany({ where: { contactId: result.contactId }, select: { id: true } });
    });
    for (const conversation of changed ?? []) this.realtime.inboxChanged(tenantId, conversation.id);
  }
}

function sameReasons(stored: string[], current: string[]): boolean {
  return stored.length === current.length && stored.every((reason, index) => reason === current[index]);
}
