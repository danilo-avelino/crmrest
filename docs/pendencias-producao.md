# Pendências para produção — Dish Desk

Atualizado em 18 de outubro de 2026.

Esta é a lista do que falta para o Dish Desk atender restaurantes de verdade. Quando um item for concluído, marque `[x]` e troque a data acima.

**De onde vem cada informação:** o que é do código e do servidor foi conferido em 11/10/2026. O estado da Meta, da Railway, do Supabase e do iFood vem das anotações das sessões anteriores (até 11/10) e precisa ser reconferido no painel de cada um antes de ser dado como certo.

## O que já está pronto

- Produção na Railway (site e painel no serviço `web`, em `https://www.dishdesk.com.br`; o painel começa em `/login`), API na Railway e banco no Supabase.
- WhatsApp e Instagram recebendo mensagens em produção (confirmado em 10/10).
- A cada envio para a `main`, o GitHub roda lint, typecheck, testes, build e E2E antes do deploy.
- Cada restaurante só enxerga os próprios dados (RLS no banco, com teste automático de vazamento).

## 1. Bloqueia atender um restaurante de verdade

- [ ] **Planos pagos** — quem faz: você
  - [x] Railway: plano Hobby assinado em 11/10/2026.
  - [ ] Supabase: sair do plano Free, que não tem backup. Backup diário é critério de aceite do MVP.
- [ ] **Análise do app na Meta** — sem ela, só contas cadastradas como testadoras conectam Instagram e WhatsApp
  - [x] Verificar a empresa (CNPJ da Avelino Gastronomia) — verificada pela Meta em 13/10 (portfólio Dish Desk, AVELINO GASTRONOMIA LTDA).
  - [x] Política de privacidade publicada: é a página `https://www.dishdesk.com.br/privacidade`, já cadastrada no app — 11/10.
  - [ ] Criar o usuário do avaliador no restaurante "Revisão Meta" e guardar a senha — você.
  - [ ] Gravar os vídeos, seguindo o [roteiro](meta-review/roteiro-video.md) — você.
  - [ ] Virar Tech Provider (WhatsApp) — você.
  - [ ] Enviar a análise, com os [textos prontos](meta-review/textos-analise.md) — você.
- [ ] **Site em `dishdesk.com.br`** — a verificação da empresa na Meta pede um site no domínio
  - [x] Landing, política de privacidade e exclusão de dados dentro do serviço `web` (`/`, `/privacidade`, `/exclusao-de-dados`); o painel começa em `/login` — Claude, em 11/10.
  - [x] Publicar (commit e push na `main`) — feito em 11/10.
  - [x] Domínio `www.dishdesk.com.br` no `web` da Railway (o `app.dishdesk.com.br` foi removido) e `WEB_ORIGIN` da API no endereço novo — 11/10.
  - [x] CNAME `www` e TXT `_railway-verify.www` criados no Registro.br; `https://www.dishdesk.com.br` responde com HTTPS (site, painel e API) — 11/10.
  - [x] Meta: redirect do Instagram `https://www.dishdesk.com.br/api/integrations/instagram/callback` e domínio do SDK do JavaScript `https://www.dishdesk.com.br/`, já sem os endereços antigos do `app` — 11/10.
  - [x] Política de privacidade e exclusão de dados do app da Meta apontando para `https://www.dishdesk.com.br/privacidade` e `/exclusao-de-dados` (substitui o documento publicado) — 11/10.
  - [ ] `dishdesk.com.br` sem `www` não abre: a Railway exige CNAME na raiz e o DNS do Registro.br não aceita. Decisão de 11/10: nada fora da Railway (sem Cloudflare). Resta testar, com você logado no Registro.br, se o redirecionamento do "modo básico" convive com o CNAME do `www`; se substituir a zona avançada, a raiz fica sem responder.
  - [ ] Apagar na zona do Registro.br os registros antigos `app` (CNAME) e `_railway-verify.app` (TXT). Não atrapalham — você, ou o Claude com o Registro.br logado.
- [ ] **Número real de WhatsApp** — a produção usa o número de teste da Meta (+1 555)
  - [ ] Escolher o número do restaurante piloto.
  - [ ] Cadastrar a forma de pagamento na conta do WhatsApp.
  - [ ] Ter o nome de exibição aprovado.
  - [ ] Criar os templates na conta de produção.
- [ ] **iFood** — a produção usa credenciais de teste
  - [x] Criar a conta Empresa (CNPJ) no Portal do Desenvolvedor — feito em 12/10 (dishdesk.crm@gmail.com, perfil Profissional).
  - [x] Cadastrar o app "Dish Desk" no Portal (Centralizado, categoria PDV, módulos Order e Events, não listado) — Claude, 12/10. Fica "Em desenvolvimento": o iFood só entrega as credenciais dele depois da homologação.
  - [x] Cadastrar o widget "Dish Desk" (Chat e Tracking de Pedidos) — Claude, 12/10.
  - [x] Pôr na `api` da Railway as três variáveis do app de teste da conta nova (`IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET`, `IFOOD_WIDGET_ID`) — feito em 12/10.
  - [x] Trocar em produção a loja de teste do Danilo Lanches para a da conta nova (`a6f11939-67e8-4855-acad-a7c46e54226e`): loja nova conectada e a antiga desconectada em Configurações → Integrações — você, 13/10.
  - [x] Pedido de teste com a credencial e a loja novas — 13/10. No ambiente local entrou e acompanhou os status até DISPATCHED; em produção o pedido #7685 entrou (PLACED) e passou a CONFIRMED.
  - [ ] **Chat do iFood na Inbox, pela extensão do Chrome** ([apps/extension](../apps/extension/README.md)). O iFood não tem API de chat; a extensão lê o widget.
    - [x] Versão 0.1.0, só leitura (ponte entre o painel e o iframe do widget) — Claude, 13/10.
    - [x] Autorizar o widget no Portal do Parceiro (login com o e-mail da conta de desenvolvedor e senha própria do Portal do Parceiro) — você, 13/10.
    - [x] Versão 0.2.0 da extensão (clicar e digitar no widget), trava `IFOOD_CHAT_BRIDGE` e a parte da API: receber a conversa lida do widget e entregar ao painel as respostas escritas na Inbox — Claude, 13/10.
    - [x] Carregar a extensão no Chrome — você, 13/10.
    - [x] Mapear a estrutura do chat e fazer o painel ler o chat e digitar as respostas (extensão 0.3.0, que informa o lado dos balões) — Claude, 13/10.
    - [x] Ligar a trava em produção (`IFOOD_CHAT_BRIDGE=true` na `api` da Railway) — 13/10. **Desligar durante a homologação do iFood.**
    - [ ] Recarregar a extensão em `chrome://extensions` (seta circular no card; precisa mostrar 0.3.0) — você.
    - [ ] Teste de ponta a ponta com um pedido de teste aberto: uma mensagem escrita como cliente (app do iFood com o usuário de testes) e uma resposta pela Inbox. É o que confirma o lado dos balões e o campo de resposta do widget — você e Claude.
    - [ ] Decidir se o widget fica mesmo invisível com a trava ligada (hoje fica: Notificações e Tracking do widget somem neste computador).
    - [x] Aviso na Inbox quando o navegador não tem a extensão, com o botão "Instalar" (abre a página da extensão na Chrome Web Store) — Claude, 13/10. O botão só aparece com o endereço da página em `IFOOD_EXTENSION_URL`.
    - [ ] Distribuição para os restaurantes: publicar a extensão na Chrome Web Store (ícones, política de privacidade) e tirar `http://localhost:3000` das origens aceitas. Depois de publicar, pôr o endereço da página em `IFOOD_EXTENSION_URL` na `api` da Railway.
  - [x] **Uma loja sem permissão derrubava o polling de todas.** O iFood responde 403 para a consulta inteira se uma das lojas não autoriza o aplicativo. Agora, no 403, o Dish Desk consulta loja a loja: a recusada fica "Com erro" (sai do polling até o restaurante conectar de novo) e as outras seguem; se todas forem recusadas, o problema é da credencial e ninguém é marcado. Ao conectar uma loja, o Dish Desk confere no iFood se ela autorizou o aplicativo e recusa ID que não é o da loja — Claude, 13/10. Publicado no commit `8c12361`.
  - [ ] Passar pela homologação. Conferido no Portal em 13/10: nenhuma homologação iniciada e nenhum ticket aberto. Para Order e Events o processo agora é automático (Portal → Homologação → Nova homologação, cerca de 10 minutos, uma tentativa a cada 4 horas, só o dono do app inicia): escolher o app e a loja de testes, testar a conexão e então confirmar, cancelar, despachar e concluir um pedido. O Dish Desk hoje só lê os eventos e os reconhece; [os critérios](https://developer.ifood.com.br/pt-BR/docs/food/guides/modules/order/homologation) pedem, pela API, confirmar o pedido (em até 8 minutos), cancelar com os motivos do iFood, avisar pedido pronto e despachar, além de mostrar pagamento, troco, cupom, observações e CPF/CNPJ.
    - [x] Confirmar, marcar como pronto, despachar e cancelar (com os motivos do iFood) pela aba Pedidos, no detalhe do pedido: um botão que muda com o status e o "Cancelar pedido" — Claude, 13/10. Conferido no painel local com o pedido de teste real #9414: confirmar, marcar como pronto e cancelar funcionaram no iFood; o "Despachar" só foi testado com iFood simulado (o endpoint em si já tinha sido usado por script no #3314).
    - [x] Mostrar no detalhe do pedido a forma de pagamento (bandeira, pago pelo app ou a cobrar, troco a levar), o cupom e quem paga, o código de coleta, o CPF/CNPJ da nota e as observações do pedido e dos itens — Claude, 13/10. Pagamento, código, documento e observação conferidos com o pedido real; troco e cupom só com iFood simulado (o pedido de teste não tem).
    - [x] Responder ao pedido de cancelamento do cliente (Plataforma de Negociação): aviso no pedido e na lista, com "Aceitar" e "Recusar" e o motivo; o desfecho entra na linha do tempo — Claude, 13/10. Só com iFood simulado: o ambiente de teste não gera negociação. Contraproposta (reembolso parcial, mais prazo) não foi feita.
    - [x] Publicar — commit `c860862`, CI verde, `api` e `web` no ar com o build novo em 13/10.
    - [ ] Desligar `IFOOD_CHAT_BRIDGE` na `api` da Railway (Variables → ⋮ da variável → Edit → `false` → Deploy) — você: a trava do Claude Code não deixa o Claude editar variável na Railway.
    - [ ] Parar a API local durante a homologação: ela usa a mesma credencial do iFood e consome os eventos que deveriam chegar à produção (em 13/10 a produção ficou com o #9414 em "Novo" porque a confirmação, o pronto e o cancelamento foram lidos pela API local) — Claude.
    - [x] Fazer as cinco etapas da homologação pelo painel de produção, com as capturas de tela enviadas ao Portal — 13/10: conectividade; receber e confirmar (#9005, #6519, #4076 e #1824); cancelar o #4076; despachar o #6519; e o #6519 concluído.
    - [x] Homologação finalizada e aprovada pelo iFood — 13/10.
  - [ ] **Pôr o app homologado em produção** (trocar as credenciais de teste pelas do app "Dish Desk"), nesta ordem:
    - [x] Publicar a proteção do polling (item acima) — 13/10.
    - [x] Item com complementos: o preço da linha passa a ser o total do item (antes aparecia o preço base) e os complementos escolhidos ficam listados no pedido (aba Pedidos, card da conversa e cadastro do cliente) — Claude, 13/10. Vale para os pedidos novos do iFood; o Cardápio Web já gravava o preço certo, mas ainda não lista os complementos.
    - [ ] `IFOOD_CHAT_BRIDGE` ligada em produção (decisão de 13/10): conferir o valor na `api` da Railway — você.
    - [ ] Primeira loja real: Terra Querida Tapiocaria (decisão de 13/10, por ter volume menor).
    - [x] Copiar no Portal do Desenvolvedor (Meus aplicativos → Dish Desk) o `clientId` e o `clientSecret` de produção — você, 13/10.
    - [ ] Em Configurações → Integrações do Danilo Lanches, desconectar a loja de teste "iFood nova conta": ela não pertence à credencial de produção — você.
    - [x] Trocar `IFOOD_CLIENT_ID` e `IFOOD_CLIENT_SECRET` na `api` da Railway — você, 13/10. Conferir se o Deploy foi feito depois da troca.
    - [ ] **Como uma loja entra (app centralizado).** Não é pela tela "Ativar integração por código" do Portal do Parceiro: aquela é dos apps distribuídos. No nosso caso quem pede é o Dish Desk: Portal do Desenvolvedor → Meus aplicativos → Dish Desk → aba Permissões → localizar a loja pelo ID ou CNPJ → confirmar e enviar. O responsável pela loja aprova no Portal do Parceiro e só então a loja é conectada em Configurações → Integrações, pelo ID da loja (o com letras e traços). Fonte: [Solicitar acessos](https://developer.ifood.com.br/pt-BR/docs/getting-started/first-steps/request-access) — você pede o acesso; a loja aprova.
    - [ ] **Aguardar o iFood liberar o app.** Em 13/10 à noite a homologação aparece como "Concluído" (relatório com 100% nos 6 cenários e "Integração pronta para produção"), mas o app "Dish Desk" está **"Em revisão"** em Meus aplicativos: falta a validação final dos especialistas do iFood. Nesse estado, pedir autorização de uma loja na aba Permissões devolve erro 400. Tentar de novo quando o status mudar; se demorar, abrir um chamado em Minhas solicitações — você.
    - [ ] **Dish Desk só acompanha os pedidos (decisão de 13/10).** Quem confirma, cancela e despacha é o sistema de pedidos da loja. Os botões de ação ficam atrás da trava `IFOOD_ORDER_ACTIONS` da `api` (sem a variável = desligada); com ela desligada, o pedido de cancelamento do cliente aparece só como aviso. O token do iFood é renovado quando uma loja recém-aprovada é conectada, para ela não cair em "Com erro" — Claude, 13/10. Falta publicar.
    - [x] Decidir se o onboarding fica assim (você pede o acesso de cada loja no Portal) ou se vale criar um app distribuído, em que o próprio restaurante digita um código: exige app novo, outra homologação e guardar um token por loja. Decidido em 18/10: **distribuído**. O app centralizado foi inativado e o "Dish Desk" Distribuído criado (Em desenvolvimento), com o app de teste "AVELINO GASTRONOMIA LTDA - Teste (D)".
    - [x] **App distribuído no código** — Claude, 18/10. Com `IFOOD_APP_TYPE=distributed` na `api`, Configurações → Integrações → iFood gera o código de vinculação; o responsável pela loja autoriza no Portal do Parceiro e cola o código de autorização; a loja (ID e nome) vem do próprio acesso, por `GET /merchant/v1.0/merchants`. Cada loja guarda o próprio acesso (cifrado no canal), renovado antes de vencer; o polling, os pedidos e as ações usam o acesso da loja. Loja conectada antes, no centralizado, fica "Com erro" e precisa ser conectada de novo pelo código. Sem a variável, tudo segue no centralizado.
    - [ ] Homologar o app distribuído (Portal → Homologação → Nova homologação, app "Dish Desk", módulos Events e Order, loja de testes "Teste - AVELINO GASTRONOMIA LTDA"). Antes: credencial do app de teste "(D)" na API que vai rodar a homologação, `IFOOD_APP_TYPE=distributed`, `IFOOD_ORDER_ACTIONS=true` e a loja de testes conectada pelo código — você e Claude. Ensaio de 18/10 na produção: os pré-requisitos estão prontos e passaram pedido de teste (chegou pelo polling com itens, pagamento, CPF e observação), confirmar, pronto, despachar e cancelar com motivo do iFood — tudo voltou do iFood na linha do tempo. Homologação feita e finalizada em 18/10 (5 etapas: conectividade, receber e confirmar, cancelar, despachar, validar), com capturas em cada uma; o iFood avisa o resultado por e-mail — Claude e você. A primeira tentativa foi **rejeitada** (81%): só o cancelamento falhou, porque a sessão do Portal venceu no meio e 3 pedidos foram descartados na retomada. Refeita no mesmo dia, sem pausa: **100% (6 de 6)**. O app está "Em revisão" (análise dos especialistas do iFood). Falta a aprovação final. Até lá, `IFOOD_ORDER_ACTIONS=true` fica ligada; depois da aprovação, desligar (decisão do usuário, 18/10).
    - [ ] **Módulos marcados sem homologação.** O app Distribuído tem Review marcado (só Order e Events são homologados automaticamente; os demais vão por chamado, com vídeos dos cenários, resposta em até 5 dias úteis). Sem o Review homologado, o app deve ficar "Parcialmente homologado". O app também não tem o módulo Merchant, mas a conexão por código usa `GET /merchant/v1.0/merchants` para descobrir a loja: confirmar se o iFood aceita essa chamada sem o módulo ou pedir o Merchant por chamado — você e Claude.
    - [ ] **Avaliações do iFood (aba Avaliações → iFood)** — Claude, 18/10. Lista as avaliações das lojas direto da Review API (sem guardar cópia), com números do período, distribuição das notas, motivos mais citados nas notas abaixo de 5 e resposta ao cliente (10 a 300 caracteres). Testado só com iFood simulado. Para ir ao ar: homologar o módulo Review por chamado (o [checklist](https://developer.ifood.com.br/pt-BR/docs/food/guides/modules/review/homologation) pede avaliações reais recentes e um link para a Política de Avaliações do iFood na tela; o link não foi encontrado na documentação) — você e Claude.
    - [ ] Depois da homologação: credencial do "Dish Desk" Distribuído e `IFOOD_APP_TYPE=distributed` na `api` da Railway, e cada loja conectada de novo pelo código — você.
    - [ ] Conferir um pedido real de ponta a ponta na primeira loja (chegar, confirmar, pronto, despachar) — você e Claude.
    - [ ] O `.env` local continua com a credencial de teste: a API local deixa de disputar eventos com a produção.

## 2. Cadastro pelo site, teste grátis e cobrança

Feito em 11/10 (Claude): o botão da landing leva a `/cadastro`, que cria o restaurante com 15 dias de teste. Depois do teste, o painel bloqueia e mostra `/assinatura`, com R$ 99 por mês no cartão (assinatura, débito automático) ou R$ 999 por ano em pagamento único, em qualquer meio de pagamento ativo na Stripe. O WhatsApp e o CPF ou CNPJ de quem se cadastrou aparecem em `/plataforma`.

Pagamento pendente (Claude, 11/10): a renovação do mensal tem 1 dia de folga; passado esse dia (ou vencido o plano anual), o painel bloqueia com a tela "Pagamento pendente". Nela, qualquer usuário do restaurante pode "Liberar acesso por confiança" por 3 dias, uma vez por atraso (o direito volta quando o pagamento chega). Durante esses dias o painel mostra no topo "Avise ao financeiro para concluir o pagamento. X dias restantes". Quem só fez o teste grátis não tem essa liberação. Em Configurações → Pagamento o administrador vê a situação, cadastra um cartão novo (plano mensal) ou gera o plano anual.

- [ ] **Conta da Stripe** — sem ela, o restaurante bloqueado vê "O pagamento ainda não está disponível"
  - [ ] Criar a conta com o CNPJ da Avelino Gastronomia e ativar, nos meios de pagamento, os que o plano anual deve aceitar (Pix, boleto, cartão): o checkout do anual mostra todos os ativos — você.
  - [ ] Criar o webhook `https://www.dishdesk.com.br/api/webhooks/stripe` com os eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded` e `invoice.paid` — você, com o Claude orientando. O do modo de teste foi criado em 12/10 (Claude), com o segredo no `.env` local; falta o do modo de produção, que tem outro segredo.
  - [ ] Pôr `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET` no serviço `api` da Railway — você.
  - [ ] Salvar as configurações do portal do cliente (Customer Portal) no painel da Stripe, com a troca de meio de pagamento ligada: sem isso, "Cadastrar novo cartão" de quem já assina o mensal responde "Não foi possível abrir o pagamento" — você, com o Claude orientando.
  - [ ] Fazer um pagamento de cada plano no modo de teste da Stripe e conferir se o restaurante é liberado; trocar o cartão pelo portal e pagar o anual com o mensal ativo, conferindo se a assinatura mensal é cancelada (o teste automático usa uma Stripe simulada).
- [ ] **Cadastro sem confirmação de e-mail.** Qualquer pessoa cria um restaurante com um e-mail que não é dela. O limite é de 10 cadastros por hora, e hoje vale para todos os visitantes somados, porque a API não enxerga o IP de quem acessa (o mesmo vale para o limite do login). Depende do provedor de e-mail e de a API confiar no proxy — Claude.
- [x] **Teste grátis repetido** — Claude, 11/10. Quem cria outra conta e conecta um canal (WhatsApp, Instagram, iFood ou Cardápio Web) que já passou por um teste grátis encerrado há menos de 60 dias tem o teste encerrado na hora e cai na tela de pagamento, com o aviso. Depois de pagar, o canal sai do restaurante antigo e conecta no novo. Continua possível repetir o teste com outro número, outra conta e outra loja.
- [ ] **Cancelar a assinatura.** O cliente não cancela pelo painel; hoje só você, no painel da Stripe.
- [ ] **Nota fiscal.** A emissão é manual, com o CPF ou CNPJ que aparece em `/plataforma` e no pagamento da Stripe.
- [ ] **Canais durante o teste.** Enquanto a Meta não aprovar o app (item 1), quem se cadastra pelo site não consegue conectar WhatsApp nem Instagram: só contas testadoras conectam.

## 3. Riscos no código

- [ ] **Token do WhatsApp sem renovação.** O cadastro incorporado usa o modelo "token de 60 dias", e o código só renova os tokens do Instagram. Um número conectado pela tela pode parar em cerca de 60 dias. Falta confirmar com um número real e resolver, com o token permanente de Tech Provider ou com um job de renovação — Claude.
- [ ] **Mídia recebida.** Desde 11/10 a conversa mostra a imagem e toca o áudio (vídeo e documento têm "Baixar"), buscando o arquivo na Meta cada vez que a conversa é aberta. Nada é guardado: quando a Meta apaga o arquivo (no WhatsApp, a documentação fala em 7 dias para o id que chega no webhook), a conversa mostra "não está mais disponível".
  - [ ] Conferir em produção com uma imagem e um áudio reais do WhatsApp e do Instagram (o teste automático usa uma Meta simulada).
  - [ ] Guardar o arquivo na chegada, para o histórico não se perder. Depende de você escolher o armazenamento (S3, R2, Supabase Storage…).
- [ ] **Recuperar senha e convite de usuário.** "Esqueceu?" só mostra "fale com o admin", e usuário novo é criado por script. Depende de você escolher o provedor de e-mail.
- [ ] **Botão "Continuar com Google".** Aparece no login de produção, mas só mostra "em breve". Decidir: esconder até existir ou implementar.
- [ ] **Monitoramento.** Sentry e painel das filas estão prontos no código, mas só ligam com as variáveis `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` e `BULL_BOARD_PASSWORD` na Railway. Falta conferir se estão lá.
- [ ] **Cabeçalhos de segurança.** A API e o painel não enviam cabeçalhos como CSP — Claude.
- [ ] **Repositório público.** O `danilo-avelino/crmrest` está público no GitHub. Decidir se continua assim — você.

## 4. Pode ficar para depois do piloto

- [ ] Versões mobile e tablet das telas.
- [ ] Envio de mídia pelo atendente.
- [ ] Integração com o Anota AI (depende do token de parceiro e da documentação).
- [ ] Cardápio Web por OAuth, no lugar da chave por loja.
- [ ] Domínio `api.dishdesk.com.br` (depende do plano pago da Railway).
- [ ] Pausar o projeto antigo do Supabase, em São Paulo.
- [ ] Apagar os 421 contatos importados só com o nome.
- [ ] Abandonar o app antigo da Meta ("Agente da Mobydick").

## Ordem sugerida

1. Planos pagos e análise da Meta: o trial acaba em poucas semanas e a análise leva semanas.
2. Enquanto a Meta analisa: token do WhatsApp, monitoramento e cabeçalhos de segurança.
3. Mídia e e-mail, assim que o armazenamento e o provedor forem escolhidos.
4. Número real de WhatsApp e iFood, conforme as aprovações saírem.

Os critérios de aceite do MVP estão no [ROADMAP.md](../ROADMAP.md), na seção "Critérios de aceite do MVP".
