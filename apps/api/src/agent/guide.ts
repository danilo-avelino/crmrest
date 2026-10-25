import type { OnboardingStep } from "@dishdesk/shared";

/**
 * A documentação do Dish Desk que o agente da extensão (E31) lê: os caminhos das telas e dos painéis de fora. Ele só
 * afirma o que está aqui e nos dados do restaurante; sem a informação, passa para o suporte humano. Curto de propósito:
 * divide o contexto da LLM com a árvore da página.
 */
export const GUIDE = `GUIA DO DISH DESK
O Dish Desk junta numa Inbox só as conversas dos clientes do restaurante (WhatsApp, Instagram, iFood) e recebe os pedidos do iFood e do Cardápio Web. As configurações ficam no menu Configurações, só para o administrador.

Implantação, nesta ordem (nenhuma integração é obrigatória: pergunte se o restaurante usa cada sistema):
1. WhatsApp: Configurações → Integrações → WhatsApp → conectar pelo QR Code. No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → apontar a câmera para o QR Code. Vale número do WhatsApp ou do WhatsApp Business.
2. Instagram: a conta precisa ser profissional. Configurações → Integrações → Instagram → entrar com o Instagram (o parceiro digita a senha).
3. iFood: Configurações → Integrações → iFood → o Dish Desk mostra um código de vinculação e o link "Abrir o Portal do Parceiro". No Portal do Parceiro (portal.ifood.com.br), com o login do responsável pela loja: conferir o código, clicar em Autorizar e copiar o código de autorização para o campo do Dish Desk. O chat do iFood vem para a Inbox pela extensão do Chrome do Dish Desk.
4. Cardápio Web: no Portal do Cardápio Web, Configurações → Integrações → API → gerar a chave; colar a chave em Configurações → Integrações → Cardápio Web. Ao conectar, a base de clientes da loja é importada.
5. Horário de funcionamento: Configurações → Horário.
6. Personalidade do atendimento (Cordial, Formal, Jovial, Descontraído, Acolhedor ou Direto) e textos das mensagens automáticas: Configurações → Mensagens automáticas.
7. Links para fazer pedido: Configurações → Links de pedido.
8. Convidar os atendentes: Configurações → Usuários (o convite vai por e-mail).
9. Pronto quando a primeira mensagem de um cliente chegar na Inbox (ex.: mandar uma mensagem de teste de outro celular para o WhatsApp conectado).

Problemas comuns:
- Canal desconectado ou com erro: Configurações → Integrações mostra o estado de cada conexão; reconectar pelo mesmo caminho da implantação.
- O chat do iFood não aparece na Inbox: a extensão do Chrome do Dish Desk precisa estar instalada e o painel do Dish Desk aberto no Chrome.`;

/** Nome de cada passo do assistente de configuração (E30), para o progresso que o agente lê. */
export const STEP_LABEL: Record<OnboardingStep, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  ifood: "iFood",
  cardapio_web: "Cardápio Web",
  business_hours: "Horário de funcionamento",
  personality: "Personalidade do atendimento",
  order_links: "Links para fazer pedido",
  members: "Convidar os atendentes",
  first_message: "Primeira mensagem de um cliente",
};
