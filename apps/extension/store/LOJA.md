# Publicação na Chrome Web Store

Tudo o que o painel do desenvolvedor da Chrome Web Store (https://chrome.google.com/webstore/devconsole) pede, na ordem das abas. Versão do pacote: **0.5.0**.

## Antes de enviar

1. **Deploy em produção** das telas novas: o painel lateral abre `https://www.dishdesk.com.br/extensao/agente`, que hoje responde 404. Sem isso, o revisor vê o painel vazio.
2. **Deploy da política de privacidade** com a seção 5 nova, "Extensão do Dish Desk para o Chrome" ([apps/web/public/privacidade/index.html](../../web/public/privacidade/index.html)).
3. **Conta de teste para o revisor:** um usuário administrador num restaurante de teste em produção, sem integrações reais. O login e a senha entram no campo "Instruções de teste".
4. **Conta de desenvolvedor:** taxa única de US$ 5 no primeiro acesso ao painel.

## Pacote

- Arquivo: [dish-desk-extensao-0.5.0.zip](dish-desk-extensao-0.5.0.zip) ("Novo item" → enviar o .zip).
- Para gerar de novo: compactar `manifest.json`, `background.js`, `panel.html`, `panel.js`, `agent-page.js`, `widget.js` e a pasta `icons/` (sem o README e sem esta pasta), com os arquivos na raiz do .zip.

## Aba "Detalhes do produto"

**Nome** (vem do manifest): Dish Desk · iFood

**Resumo** (vem do manifest, até 132 caracteres): Ponte entre o painel do Dish Desk e o widget do iFood, e o assistente de implantação e suporte do Dish Desk.

**Descrição:**

> Extensão para restaurantes que usam o Dish Desk, o CRM de atendimento que junta numa caixa de entrada só as conversas do WhatsApp, do Instagram e do iFood.
>
> Chat do iFood na Inbox: com a extensão, as mensagens do chat dos pedidos do iFood chegam na caixa de entrada do Dish Desk, e a equipe responde por lá.
>
> Assistente de implantação e suporte: clique no ícone da extensão para abrir o painel lateral. Peça em linguagem natural ("conecta o meu Cardápio Web") e a IA do Dish Desk faz o passo a passo junto com você, inclusive no Portal do Parceiro iFood, no Portal do Cardápio Web e na Meta. Ela também tira dúvidas e investiga problemas, como um canal desconectado.
>
> Você vê tudo o que a IA faz: cada ação aparece no painel, e a página mostra o botão ou o campo em que ela vai mexer. Antes do que não dá para desfazer, como aceitar termos, ela pede a sua confirmação. Senhas, códigos de verificação e dados de cartão são sempre digitados por você: a IA nunca vê esses campos. Se você começa a usar a página, ela pausa sozinha.
>
> Requer uma conta do Dish Desk (www.dishdesk.com.br).

**Categoria:** Produtividade → Fluxo de trabalho e planejamento (ou Comunicação, se preferir destacar o chat do iFood).

**Idioma:** Português (Brasil).

## Aba "Recursos gráficos"

| Campo | Arquivo |
|---|---|
| Ícone 128×128 | [icons/icon-128.png](../icons/icon-128.png) |
| Capturas de tela 1280×800 | [captura-1.png](captura-1.png) (passo concluído), [captura-2.png](captura-2.png) (confirmar ação), [captura-3.png](captura-3.png) (início do painel) |
| Bloco promocional pequeno 440×280 | [bloco-promocional-440x280.png](bloco-promocional-440x280.png) |

## Aba "Informações adicionais"

- **Site oficial:** https://www.dishdesk.com.br/
- **URL de suporte:** https://www.dishdesk.com.br/ (e-mail de contato: dishdesk.crm@gmail.com)

## Aba "Práticas de privacidade"

**Finalidade única:**

> Ligar o navegador da equipe do restaurante ao Dish Desk: levar o chat dos pedidos do iFood para a caixa de entrada do Dish Desk e ajudar a equipe a configurar e usar o Dish Desk com um assistente no painel lateral.

**Justificativa de cada permissão:**

| Permissão | Justificativa |
|---|---|
| `sidePanel` | O assistente do Dish Desk fica no painel lateral do Chrome, aberto pelo ícone da extensão. |
| `scripting` | Quando a equipe pede ajuda no painel, o assistente injeta um script na aba aberta para ler os botões e campos da página e executar a ação pedida (clicar, preencher), mostrando na página o que está fazendo. Só roda quando o assistente precisa. |
| `tabs` | Saber qual aba a equipe está vendo, abrir nela o endereço de um passo da configuração e esperar a página carregar antes da próxima ação. |
| `storage` | Guardar o endereço do painel do Dish Desk usado pela extensão. |
| Acesso a `www.dishdesk.com.br` | O painel lateral carrega a tela do assistente do Dish Desk. |
| Acesso a `localhost:3000` | Usado só no desenvolvimento do Dish Desk, para testar o painel local. |
| Acesso a `portal.ifood.com.br`, `*.cardapioweb.com`, `*.facebook.com`, `*.instagram.com` | Os painéis de fora em que o assistente executa a configuração junto com o restaurante: autorizar a loja no iFood, gerar a chave do Cardápio Web e conectar o Instagram e o WhatsApp na Meta. |
| Script em `embeddables.ifood.com.br` | Lê as mensagens do chat dos pedidos no widget oficial do iFood aberto no Dish Desk e escreve nele as respostas da equipe. |
| Acesso opcional a `https://*/*` | Pedido site a site, só quando a configuração passa por outro site (ex.: login da conta Google no Cardápio Web) e a pessoa clica em "Permitir" no painel. Nada é pedido na instalação. |

**Código remoto:** Não. Todo o JavaScript da extensão está no pacote. O painel lateral mostra uma página do Dish Desk num iframe, e o que vem da IA são só dados (qual elemento clicar ou preencher), executados pelo script do pacote.

**Uso de dados (marcar):**

- **Informações de identificação pessoal:** sim (nomes e telefones de clientes que aparecem no chat do iFood e nas páginas lidas pelo assistente).
- **Comunicações pessoais:** sim (mensagens do chat dos pedidos do iFood).
- **Conteúdo do site:** sim (texto, botões e campos da página que o assistente lê).
- **Informações de autenticação:** não (a extensão nunca lê senha, código de verificação nem cartão; esses valores não saem da página).
- **Atividade do usuário:** não. A extensão percebe um clique ou uma tecla na página só para pausar o assistente; o que foi clicado ou digitado não é lido nem enviado.
- Demais categorias (saúde, financeiras, localização, histórico da Web): não.

**Declarações (marcar as três):** não vendo nem transfiro dados a terceiros fora dos usos aprovados; não uso nem transfiro dados para fins não relacionados à finalidade única; não uso nem transfiro dados para avaliar crédito ou conceder empréstimos.

**URL da política de privacidade:** https://www.dishdesk.com.br/privacidade

## Aba "Distribuição"

- **Visibilidade:** "Não listado" (só quem tem o link instala; o Dish Desk manda o link aos restaurantes). Depois de publicada, pôr o endereço da página da extensão na variável `IFOOD_EXTENSION_URL` da `api` na Railway: é ele que liga o botão "Instalar" da Inbox e o "Adicionar ao Chrome" do assistente.
- **Regiões:** Brasil.

## Instruções de teste (para o revisor)

> Entre em https://www.dishdesk.com.br/login com o usuário de teste abaixo. Clique no ícone da extensão para abrir o painel lateral e escolha "Preciso de ajuda" ou "Configurar o Dish Desk". O chat do iFood depende de uma loja real do iFood e não aparece na conta de teste.
>
> Usuário: (preencher)
> Senha: (preencher)
