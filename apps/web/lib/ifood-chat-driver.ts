import type { IfoodChatOutboxItem, IfoodChatSendResult, IfoodChatSync, IfoodChatSyncResult } from "@dishdesk/shared";
import { CHAT_ITEM, CHAT_TAB, LAUNCHER, readWidget, type WidgetChat, type WidgetDrawer, type WidgetState } from "./ifood-chat-dom";

/** Pedido à extensão do Chrome que roda dentro do widget (apps/extension); rejeita se ela não responder ou recusar. */
export type Bridge = (op: string, params?: Record<string, unknown>) => Promise<{ html?: string[]; version?: string }>;

export type IfoodChatApi = {
  sync(body: IfoodChatSync): Promise<IfoodChatSyncResult>;
  claim(): Promise<IfoodChatOutboxItem[]>;
  result(messageId: string, body: IfoodChatSendResult): Promise<void>;
};

/** `unauthorized`: a loja precisa autorizar o widget neste computador; o motor para até a página recarregar. */
export type DriverStatus = "working" | "unauthorized";

/** A conversa aberta demora a carregar: quantas leituras esperar, e o intervalo entre elas. */
const READ_ATTEMPTS = 12;
const READ_WAIT_MS = 500;
/** Conversa que não deu para copiar (pedido ainda fora do Dish Desk, erro): quando tentar de novo, e até quantas vezes. */
const RETRY_MS = 30_000;
const MAX_TRIES = 10;
/** O que a API aceita por conversa. */
const MAX_MESSAGES = 200;

const DAY = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

/**
 * Copia o chat do widget do iFood para a Inbox e digita nele as respostas escritas na Inbox. Trabalha em passos curtos
 * (no máximo uma conversa lida ou uma resposta enviada por passo), sempre deixando o widget na aba Chat, sem conversa aberta.
 */
export class IfoodChatDriver {
  /** Como cada conversa estava na lista (prévia e hora) quando foi copiada: só é aberta de novo quando muda. */
  private readonly copied = new Map<string, string>();
  private readonly retryAt = new Map<string, number>();
  private readonly tries = new Map<string, number>();
  private readonly outbox: IfoodChatOutboxItem[] = [];

  constructor(
    private readonly bridge: Bridge,
    private readonly api: IfoodChatApi,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  /** `claim`: perguntar à API se há respostas novas da Inbox para enviar. */
  async step(claim: boolean): Promise<DriverStatus> {
    const state = await this.read();
    if (state.unauthorized) return "unauthorized";
    if (!state.panel) return this.click(LAUNCHER);
    if (!state.chatTab) return this.click(CHAT_TAB);
    // Conversa que ficou aberta de um passo interrompido: fecha antes de seguir.
    if (state.drawers[0]) return this.click(state.drawers[0].close);

    if (claim) this.outbox.push(...(await this.api.claim()));
    const reply = this.outbox.shift();
    if (reply) await this.send(reply);
    else {
      const changed = state.chats.find((chat) => this.changed(chat));
      if (changed) await this.copy(changed);
    }
    return "working";
  }

  private async read(): Promise<WidgetState> {
    const { html } = await this.bridge("html", { selector: "body", geometry: true });
    return readWidget(html?.[0] ?? "");
  }

  private async click(selector: string, index?: number): Promise<DriverStatus> {
    await this.bridge("click", { selector, index });
    return "working";
  }

  private changed(chat: WidgetChat): boolean {
    if (this.copied.get(chat.orderCode) === shownAs(chat)) return false;
    if ((this.retryAt.get(chat.orderCode) ?? 0) > this.now()) return false;
    // Conversas encerradas ficam dias na lista: delas, só as de hoje são copiadas.
    return chat.open || chat.stamp.includes(DAY.format(this.now()));
  }

  private async copy(chat: WidgetChat): Promise<void> {
    const drawer = await this.open(chat.orderCode);
    try {
      const messages = drawer && transcript(drawer);
      if (!drawer || !messages?.length) {
        if (drawer && !messages) console.warn(`Chat do iFood #${chat.orderCode}: não deu para saber quem enviou as mensagens; a conversa não foi copiada.`);
        this.postpone(chat);
        return;
      }
      const { found } = await this.api.sync({ orderCode: chat.orderCode, messages: messages.slice(-MAX_MESSAGES) });
      if (!found) return this.postpone(chat);
      this.copied.set(chat.orderCode, shownAs(chat));
      this.tries.delete(chat.orderCode);
    } catch (error) {
      this.postpone(chat);
      throw error;
    } finally {
      if (drawer) await this.bridge("click", { selector: drawer.close }).catch(() => undefined);
    }
  }

  /** Tenta de novo mais tarde; depois de MAX_TRIES, só quando a conversa mudar na lista. */
  private postpone(chat: WidgetChat): void {
    const tries = (this.tries.get(chat.orderCode) ?? 0) + 1;
    if (tries < MAX_TRIES) {
      this.tries.set(chat.orderCode, tries);
      this.retryAt.set(chat.orderCode, this.now() + RETRY_MS);
    } else {
      this.tries.delete(chat.orderCode);
      this.copied.set(chat.orderCode, shownAs(chat));
    }
  }

  private async send(reply: IfoodChatOutboxItem): Promise<void> {
    let drawer: WidgetDrawer | null = null;
    let outcome: IfoodChatSendResult;
    try {
      drawer = await this.open(reply.orderCode);
      if (!drawer) outcome = { status: "FAILED", error: "O chat deste pedido não está aberto no widget do iFood." };
      else if (!drawer.input) outcome = { status: "FAILED", error: "O iFood já encerrou a conversa deste pedido." };
      else {
        const before = occurrences(drawer, reply.text);
        await this.bridge("fill", { selector: drawer.input, text: reply.text });
        if (drawer.send) await this.bridge("click", { selector: drawer.send });
        else await this.bridge("key", { selector: drawer.input, key: "Enter" });
        const shown = await this.until(reply.orderCode, (current) => occurrences(current, reply.text) > before);
        outcome = shown ? { status: "SENT" } : { status: "FAILED", error: "O widget do iFood não confirmou o envio da mensagem." };
      }
    } catch {
      outcome = { status: "FAILED", error: "O widget do iFood não aceitou a mensagem." };
    }
    if (drawer) await this.bridge("click", { selector: drawer.close }).catch(() => undefined);
    await this.api.result(reply.messageId, outcome);
  }

  /** Abre a conversa do pedido e espera as mensagens carregarem (duas leituras seguidas com a mesma quantidade). */
  private async open(orderCode: string): Promise<WidgetDrawer | null> {
    // A posição na lista é lida logo antes do clique: ela muda quando chega mensagem em outra conversa.
    const chats = (await this.read()).chats.filter((chat) => chat.orderCode === orderCode);
    const chat = chats.find((item) => item.open) ?? chats[0];
    if (!chat) return null;
    await this.bridge("click", { selector: CHAT_ITEM, index: chat.index });
    let loaded = 0;
    return this.until(orderCode, (drawer) => {
      const stable = drawer.bubbles.length > 0 && drawer.bubbles.length === loaded;
      loaded = drawer.bubbles.length;
      return stable;
    });
  }

  /** Relê a conversa aberta até a condição valer; null se o tempo acabar antes (o passo seguinte fecha o que ficou aberto). */
  private async until(orderCode: string, done: (drawer: WidgetDrawer) => boolean): Promise<WidgetDrawer | null> {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      await this.wait(READ_WAIT_MS);
      const drawer = (await this.read()).drawers.find((item) => item.orderCode === orderCode);
      if (drawer && done(drawer)) return drawer;
    }
    return null;
  }
}

function shownAs(chat: WidgetChat): string {
  return `${chat.preview}|${chat.stamp}`;
}

/** As mensagens da conversa para a API; null se alguma não diz de que lado está. */
function transcript(drawer: WidgetDrawer): IfoodChatSync["messages"] | null {
  const messages: IfoodChatSync["messages"] = [];
  for (const bubble of drawer.bubbles) {
    if (!bubble.direction) return null;
    messages.push({ direction: bubble.direction, text: bubble.text, time: bubble.time });
  }
  return messages;
}

function occurrences(drawer: WidgetDrawer, text: string): number {
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  return drawer.bubbles.filter((bubble) => squash(bubble.text) === squash(text)).length;
}
