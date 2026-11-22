import { cartSubtotal, cartTools } from "./cart-tools.js";
import type { AnyTool, MenuAgentDeps, MenuAgentSession } from "./context.js";
import { readTools } from "./read-tools.js";

export type { MenuAgentDeps, MenuAgentSession } from "./context.js";

/**
 * Ferramentas do agente de pedidos (F4-01, F4-02) para uma conversa. O restaurante vem do `ctx.tenantId` que o
 * `LlmProvider` passa (o da conversa); a conversa e o contato ficam fixos aqui. Nada vem do modelo.
 */
export function menuAgentTools(deps: MenuAgentDeps, session: MenuAgentSession): AnyTool[] {
  return [...readTools(deps, cartSubtotal(session)), ...cartTools(deps, session)];
}
