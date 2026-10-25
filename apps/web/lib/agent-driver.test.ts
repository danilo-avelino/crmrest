import type { AgentAction, AgentPageAction, AgentTurnDto, AgentTurnRequest, PageSnapshot } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import type { AgentBridge } from "./agent-bridge";
import { answerConfirmation, answerPermission, MAX_ACTIONS, runAgent } from "./agent-driver";

const PAGE: PageSnapshot = { url: "https://www.dishdesk.com.br/configuracoes", title: "Configurações", elements: [], text: "" };
const turnOf = (next: AgentAction): AgentTurnDto => ({ sessionId: "s", status: "ACTIVE", next, progress: null });
const click = (ref: number): AgentAction => ({ type: "act", say: "Vou clicar.", action: { type: "click", ref, label: `item ${ref}` } });

/** A API e a extensão de mentira: a API responde na ordem dada; a extensão anota o que executou. */
function fakes(replies: AgentAction[], options: { failing?: number[]; granted?: boolean } = {}) {
  const sent: AgentTurnRequest[] = [];
  const done: AgentPageAction[] = [];
  const api = async (body: AgentTurnRequest) => {
    sent.push(body);
    return turnOf(replies.shift() ?? { type: "reply", say: "Pronto." });
  };
  const bridge: AgentBridge = {
    snapshot: async () => PAGE,
    act: async (action) => {
      done.push(action);
      if (action.type === "click" && options.failing?.includes(action.ref)) throw new Error("elemento sumiu");
    },
    focus: async () => undefined,
    permission: async () => options.granted ?? false,
  };
  return { api, bridge, sent, done };
}

describe("agente da extensão: o ciclo", () => {
  it("executa as ações e volta com o resultado e a página, até a IA precisar do parceiro", async () => {
    const { api, bridge, sent, done } = fakes([click(1), click(2), { type: "reply", say: "Você usa o iFood?" }], { failing: [2] });
    const last = await runAgent(api, bridge, { message: "Configura o Dish Desk" });

    expect(last.next).toEqual({ type: "reply", say: "Você usa o iFood?" });
    expect(done.map((action) => (action.type === "click" ? action.ref : null))).toEqual([1, 2]);
    expect(sent).toEqual([
      { message: "Configura o Dish Desk", page: PAGE },
      { result: { ok: true }, page: PAGE },
      { result: { ok: false, error: "elemento sumiu" }, page: PAGE },
    ]);
  });

  it("pausado, termina a ação atual e não faz a próxima", async () => {
    const controller = new AbortController();
    const { api, bridge, done } = fakes([click(1), click(2), click(3)]);
    const last = await runAgent(api, bridge, { message: "Vai" }, { signal: controller.signal, onStep: () => controller.abort() });
    expect(done).toHaveLength(1);
    expect(last.next).toMatchObject({ type: "act", action: { ref: 2 } });
  });

  it("para depois de muitas ações seguidas sem o parceiro", async () => {
    const { api, bridge, done } = fakes(Array.from({ length: MAX_ACTIONS + 5 }, (_, index) => click(index + 1)));
    await runAgent(api, bridge, { message: "Vai" });
    expect(done).toHaveLength(MAX_ACTIONS);
  });

  it("confirmação: só executa com o sim do parceiro", async () => {
    const action: AgentPageAction = { type: "click", ref: 5, label: "Aceitar termos" };
    const yes = fakes([]);
    await answerConfirmation(yes.api, yes.bridge, action, true);
    expect(yes.done).toEqual([action]);
    expect(yes.sent[0]).toEqual({ confirmed: true, result: { ok: true }, page: PAGE });

    const no = fakes([]);
    await answerConfirmation(no.api, no.bridge, action, false);
    expect(no.done).toEqual([]);
    expect(no.sent[0]).toEqual({ confirmed: false, page: PAGE });
  });

  it("permissão de site: a IA fica sabendo se o parceiro permitiu", async () => {
    const granted = fakes([], { granted: true });
    await answerPermission(granted.api, granted.bridge, "exemplo.com");
    expect(granted.sent[0]).toEqual({ granted: "exemplo.com", page: PAGE });

    const denied = fakes([], { granted: false });
    await answerPermission(denied.api, denied.bridge, "exemplo.com");
    expect(denied.sent[0]).toEqual({ message: "Não permiti agir em exemplo.com.", page: PAGE });
  });
});
