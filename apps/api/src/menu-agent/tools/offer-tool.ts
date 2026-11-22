import { z } from "zod";
import { OFFER_MAX, OFFER_MIN, OPTION_TITLE_MAX } from "../choices.js";
import { defineTool } from "./context.js";

export type OfferedOptions = { question: string; options: { id: string; title: string }[] };

/**
 * `oferecer_opcoes` (F4-05): o modelo só diz a pergunta e as opções fechadas. Quem mostra é o OrderAgentService: botões
 * ou lista no WhatsApp da API oficial, texto numerado nos outros canais. O texto final do modelo vira a pergunta.
 */
export function offerTool(onOffer: (offer: OfferedOptions) => void) {
  return defineTool({
    name: "oferecer_opcoes",
    description:
      "Mostra ao cliente uma pergunta com opções fechadas (de 2 a 10), como tamanhos, sabores, entrega ou retirada, ou sim e não. O sistema monta os botões ou a lista numerada: o seu texto final deve ser só a pergunta, sem repetir nem numerar as opções. Use só para escolher entre opções que vieram das ferramentas. Depois, o cliente responde com o número, o nome ou o botão, e você recebe a escolha.",
    inputSchema: z.object({
      pergunta: z.string().min(1).max(500).describe("A pergunta ao cliente, sem as opções."),
      opcoes: z
        .array(z.object({ id: z.string().min(1).max(100).describe("Id curto da opção, só para você."), titulo: z.string().min(1).max(OPTION_TITLE_MAX) }))
        .min(OFFER_MIN)
        .max(OFFER_MAX),
    }),
    handler: (input) => {
      const ids = new Set(input.opcoes.map((option) => option.id));
      const titles = new Set(input.opcoes.map((option) => option.titulo.trim().toLowerCase()));
      if (ids.size !== input.opcoes.length || titles.size !== input.opcoes.length) return { ok: false, erro: "Cada opção precisa de um id e um título diferentes." };
      onOffer({ question: input.pergunta.trim(), options: input.opcoes.map((option) => ({ id: option.id, title: option.titulo.trim() })) });
      return { ok: true, proximoPasso: "As opções vão ao cliente com a sua resposta. Escreva só a pergunta, sem listar nem numerar as opções, e não chame mais ferramentas." };
    },
  });
}
