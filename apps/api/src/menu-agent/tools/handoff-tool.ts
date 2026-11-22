import { z } from "zod";
import { defineTool } from "./context.js";

/**
 * `transferir_para_humano` (parte de F4-03): o modelo só pede a transferência e dá o motivo. Quem passa a conversa
 * para a equipe é o OrderAgentService, depois da resposta, pelo mesmo caminho do atendimento com IA (ai = "off",
 * evento "handoff" e o alarme da equipe).
 */
export function handoffTool(onHandoff: (reason: string) => void) {
  return defineTool({
    name: "transferir_para_humano",
    description:
      "Passa a conversa para a equipe do restaurante: o cliente pediu uma pessoa, falou de pagamento, de um problema ou reclamação, de cancelamento, ou você não consegue resolver com as ferramentas. Depois dela, só avise que alguém da equipe vai continuar.",
    inputSchema: z.object({ motivo: z.string().describe("Para a equipe, em até 200 caracteres: por que transferiu.") }),
    handler: (input) => {
      onHandoff(input.motivo.trim().slice(0, 200));
      return {
        ok: true,
        proximoPasso: "Diga ao cliente, numa frase, que alguém da equipe vai continuar por aqui. Não faça perguntas e não chame mais ferramentas.",
      };
    },
  });
}
