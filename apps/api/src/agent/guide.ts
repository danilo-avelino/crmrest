import type { OnboardingStep } from "@dishdesk/shared";

/**
 * A documentação do Dish Desk que o agente da extensão (E31) lê: os caminhos das telas e dos painéis de fora. Ele só
 * afirma o que está aqui e nos dados do restaurante; sem a informação, passa para o suporte humano. Curto de propósito:
 * divide o contexto da LLM com a árvore da página.
 */
export const GUIDE = `GUIA DO DISH DESK
O Dish Desk junta numa Inbox só as conversas dos clientes do restaurante (WhatsApp, Instagram, iFood) e recebe os pedidos do iFood e do Cardápio Web. As configurações ficam no menu Configurações, só para o administrador. Cada tela abre direto pelo endereço (navigate: endereço do painel + o caminho abaixo), sem clicar em menus.

Implantação, nesta ordem (nenhuma integração é obrigatória: pergunte se o restaurante usa cada sistema):
1. WhatsApp: abra /configuracoes/integracoes?conectar=WHATSAPP (abre o QR Code). Parceiro, no celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → apontar a câmera para o QR Code. Vale número do WhatsApp ou do WhatsApp Business. O passo termina quando o PROGRESSO mostrar o WhatsApp como feito.
2. Instagram: a conta precisa ser profissional. Abra /configuracoes/integracoes?conectar=INSTAGRAM → clicar em entrar com o Instagram: abre um popup (janela separada) onde o parceiro digita a senha; peça a vez dele (your_turn) e, quando ele terminar, o popup fecha sozinho e a página mostra o resultado.
3. iFood: abra /configuracoes/integracoes?conectar=IFOOD: o Dish Desk mostra um código de vinculação (o texto da página) e o link "Abrir o Portal do Parceiro". Use login em https://portal.ifood.com.br (aba nova; o parceiro entra com o usuário e a senha do responsável pela loja). Guarde o código de vinculação ANTES de sair da aba do Dish Desk. No Portal do Parceiro, depois do login, a sua PRIMEIRA ação é navigate para https://portal.ifood.com.br/apps (na aba do portal; é a página de aplicativos). Nunca clique nos menus do portal (Integrações, Financeiro, etc.) e nunca peça ao parceiro para procurar nada nele. Nessa página, clique em "Ativar integração por código": o código de vinculação do Dish Desk é o que vai nesse campo (você mesma preenche, o parceiro não digita nem cola nada; ele vem do Dish Desk, não é código de verificação). Clique em Continuar/Autorizar e leia o código de autorização que aparece depois (é outro, diferente do código de vinculação). Volte à aba do Dish Desk com switch (www.dishdesk.com.br), onde o modal do iFood continua aberto, preencha o campo "Código de autorização" com ele e clique em Conectar. O chat do iFood vem para a Inbox pela extensão do Chrome do Dish Desk.
4. Cardápio Web: abra /configuracoes/integracoes?conectar=CARDAPIO_WEB (o modal pede Código da loja, Chave de API e Nome). Não peça esses dados ao parceiro: use login em https://portal.cardapioweb.com/login (aba nova); ele entra e escolhe a loja que quer integrar, e só avisa quando terminar. Depois, no Portal do Cardápio Web, faça você mesma (sem rolar: clique direto no elemento da PÁGINA): no menu da esquerda, clique em "Configurações" (fica no fim do menu); no menu de Configurações, clique em "Integrações"; na lista, clique em "API de integração" (a última seção, "API's para integrações"). Abre uma gaveta à direita com o "Código da loja" (só números, ex.: 13047) e o token logo abaixo (o campo ao lado de "Copiar token"): o token é a Chave de API. O nome da loja fica no alto do menu da esquerda, acima de tudo (ex.: "Aglio Nero"; a cidade embaixo não faz parte do nome). Nunca clique em "Gerar um novo token": o token atual deixaria de funcionar nos outros sistemas da loja; se não houver token, passe para o suporte (handoff). Volte à aba do Dish Desk com switch (www.dishdesk.com.br), onde o modal continua aberto, preencha Código da loja, Chave de API e Nome com o que leu (a PÁGINA ANTERIOR mostra o portal) e clique em Conectar. Ao conectar, a base de clientes da loja é importada.
5. Horário de funcionamento: /configuracoes/horario.
6. Personalidade do atendimento (Cordial, Formal, Jovial, Descontraído, Acolhedor ou Direto) e textos das mensagens automáticas: /configuracoes/mensagens.
7. Links para fazer pedido: /configuracoes (primeira aba, Links de pedido).
8. Convidar os atendentes: /configuracoes/usuarios → "Novo usuário": preencha nome e e-mail e deixe a senha temporária em branco (o convite vai por e-mail).
9. Pronto quando a primeira mensagem de um cliente chegar na Inbox: peça ao parceiro para mandar uma mensagem de teste, de outro celular, para o WhatsApp conectado.

Problemas comuns:
- Canal desconectado ou com erro: /configuracoes/integracoes mostra o estado de cada conexão; reconectar pelo mesmo atalho da implantação (?gerenciar=WHATSAPP, ?gerenciar=IFOOD...).
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
