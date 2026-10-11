# Pendências para produção — Dish Desk

Atualizado em 11 de outubro de 2026.

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
  - [ ] Criar a conta Empresa (CNPJ) no Portal do Desenvolvedor — você.
  - [ ] Passar pela homologação.
  - [ ] Cadastrar o widget e configurar o `IFOOD_WIDGET_ID` — Claude, depois da conta Empresa.

## 2. Riscos no código

- [ ] **Token do WhatsApp sem renovação.** O cadastro incorporado usa o modelo "token de 60 dias", e o código só renova os tokens do Instagram. Um número conectado pela tela pode parar em cerca de 60 dias. Falta confirmar com um número real e resolver, com o token permanente de Tech Provider ou com um job de renovação — Claude.
- [ ] **Mídia recebida.** Desde 11/10 a conversa mostra a imagem e toca o áudio (vídeo e documento têm "Baixar"), buscando o arquivo na Meta cada vez que a conversa é aberta. Nada é guardado: quando a Meta apaga o arquivo (no WhatsApp, a documentação fala em 7 dias para o id que chega no webhook), a conversa mostra "não está mais disponível".
  - [ ] Conferir em produção com uma imagem e um áudio reais do WhatsApp e do Instagram (o teste automático usa uma Meta simulada).
  - [ ] Guardar o arquivo na chegada, para o histórico não se perder. Depende de você escolher o armazenamento (S3, R2, Supabase Storage…).
- [ ] **Recuperar senha e convite de usuário.** "Esqueceu?" só mostra "fale com o admin", e usuário novo é criado por script. Depende de você escolher o provedor de e-mail.
- [ ] **Botão "Continuar com Google".** Aparece no login de produção, mas só mostra "em breve". Decidir: esconder até existir ou implementar.
- [ ] **Monitoramento.** Sentry e painel das filas estão prontos no código, mas só ligam com as variáveis `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` e `BULL_BOARD_PASSWORD` na Railway. Falta conferir se estão lá.
- [ ] **Cabeçalhos de segurança.** A API e o painel não enviam cabeçalhos como CSP — Claude.
- [ ] **Repositório público.** O `danilo-avelino/crmrest` está público no GitHub. Decidir se continua assim — você.

## 3. Pode ficar para depois do piloto

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
