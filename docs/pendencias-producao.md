# Pendências para produção — Dish Desk

Atualizado em 13 de outubro de 2026.

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
  - [ ] Verificar a empresa (CNPJ da Avelino Gastronomia) — você, com o Claude criando o registro de domínio.
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
    - [ ] Carregar a extensão 0.2.0 no Chrome (`chrome://extensions` → Modo do desenvolvedor → Carregar sem compactação → `apps/extension`) e recarregar a aba do Dish Desk — você. Em 13/10 a ponte ainda não respondia no painel.
    - [ ] Mapear a estrutura do chat (há uma conversa de teste aberta, pedido #6530) e fazer o painel ler o chat e digitar as respostas — Claude, depois do item acima.
    - [ ] Ligar a trava em produção (`IFOOD_CHAT_BRIDGE=true` na `api` da Railway) — depois de testado. Desligar durante a homologação do iFood.
    - [ ] Distribuição para os restaurantes: publicar a extensão na Chrome Web Store (ícones, política de privacidade) e tirar `http://localhost:3000` das origens aceitas.
  - [ ] **Uma loja sem permissão derruba o polling de todas.** O Dish Desk consulta todas as lojas iFood numa chamada só, e o iFood responde 403 para a chamada inteira se uma delas não pertence à credencial (aconteceu em 13/10 com a loja de teste antiga ainda conectada). Com clientes reais, um restaurante que revogar o app no iFood deixa todos sem pedidos. Isolar a loja recusada e seguir com as outras — Claude.
  - [ ] Passar pela homologação: abrir o ticket no app "Dish Desk" (botão "Abrir ticket"). A categoria PDV pede o fluxo completo do pedido (confirmar, despachar, cancelar), que o Dish Desk não faz hoje; conferir os critérios antes de abrir.
  - [ ] Depois da homologação, trocar as credenciais de teste pelas do app "Dish Desk".

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
