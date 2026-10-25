import type { AgentPageAction, AgentTurnDto, AgentTurnRequest, PageSnapshot } from "@dishdesk/shared";
import type { AgentBridge } from "./agent-bridge";

/** Uma volta na API do agente (POST /agent/sessions/:id/turn). */
export type AgentTurnApi = (body: AgentTurnRequest) => Promise<AgentTurnDto>;

/** Ações seguidas que a IA faz sozinha antes de parar e esperar o parceiro (proteção contra um ciclo sem fim). */
export const MAX_ACTIONS = 25;

export type RunOptions = {
  /** Pausar ou Parar: a IA termina a ação atual e não faz a próxima. */
  signal?: AbortSignal;
  /** A cada ação que a IA vai fazer (para a tela mostrar "Clicando em…"). */
  onStep?: (turn: AgentTurnDto) => void;
  /** Quando a ação termina (feita ou falhou). */
  onResult?: (result: { ok: boolean; error?: string }) => void;
};

/**
 * O ciclo do agente (E31): lê a aba, pergunta à API e executa a ação que voltou, até a IA precisar do parceiro (responder,
 * confirmar, a vez dele, permitir um site) ou terminar. Devolve a última volta, que diz o que a tela mostra.
 * `input`: o que o parceiro acabou de fazer (a mensagem, a resposta a uma confirmação ou a uma permissão).
 */
export async function runAgent(api: AgentTurnApi, bridge: AgentBridge, input: AgentTurnRequest, options: RunOptions = {}): Promise<AgentTurnDto> {
  let turn = await api({ ...input, page: await read(bridge) });
  for (let actions = 0; turn.next.type === "act" && actions < MAX_ACTIONS && !options.signal?.aborted; actions++) {
    options.onStep?.(turn);
    const result = await execute(bridge, turn.next.action);
    options.onResult?.(result);
    turn = await api({ result, page: await read(bridge) });
  }
  return turn;
}

/** "Confirmar ação": o parceiro confirmou; a extensão executa e a IA continua. "Não fazer": a IA decide outra coisa. */
export async function answerConfirmation(
  api: AgentTurnApi,
  bridge: AgentBridge,
  action: AgentPageAction,
  confirmed: boolean,
  options: RunOptions = {},
): Promise<AgentTurnDto> {
  if (!confirmed) return runAgent(api, bridge, { confirmed: false }, options);
  const result = await execute(bridge, action);
  options.onResult?.(result);
  return runAgent(api, bridge, { confirmed: true, result }, options);
}

/** "Permitir" um site fora da lista: o Chrome pergunta ao parceiro; sem a permissão, a IA fica sabendo pela mensagem. */
export async function answerPermission(api: AgentTurnApi, bridge: AgentBridge, host: string, options: RunOptions = {}): Promise<AgentTurnDto> {
  const granted = await bridge.permission(host).catch(() => false);
  return runAgent(api, bridge, granted ? { granted: host } : { message: `Não permiti agir em ${host}.` }, options);
}

async function execute(bridge: AgentBridge, action: AgentPageAction): Promise<{ ok: boolean; error?: string }> {
  try {
    await bridge.act(action);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}

/** A aba atual; numa página que a extensão não lê (ex.: a página de extensões do Chrome), a IA segue sem ela. */
async function read(bridge: AgentBridge): Promise<PageSnapshot | undefined> {
  return bridge.snapshot().catch(() => undefined);
}
