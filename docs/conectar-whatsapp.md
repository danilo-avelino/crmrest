# Como conectar um número de WhatsApp Business ao Dish Desk

Passo a passo para o dono (ou administrador) do restaurante. A conexão é feita pela tela de Integrações, usando o cadastro oficial da Meta. As telas da Meta mudam de tempo em tempo, então os nomes dos botões podem variar um pouco.

## Antes de começar

Você precisa de:

- Ser **administrador** do restaurante no Dish Desk. Só o administrador adiciona integrações.
- Uma conta pessoal do **Facebook**. Ela só serve para entrar na janela da Meta.
- O **número** do restaurante, com o celular na mão para receber código por SMS, ligação ou QR.

## Escolha o seu caso

### Caso A: o número já usa o app WhatsApp Business no celular (recomendado)

Pela Coexistência da Meta, o número continua funcionando no app do celular **e** passa a funcionar também no Dish Desk. Nada é perdido.

- Deixe o app **WhatsApp Business** atualizado.
- O número deve estar em uso normal no app.
- Na janela da Meta, escolha a opção de **conectar o app** e escaneie o QR code com o celular.

### Caso B: o número é novo, ou está num WhatsApp comum

- Um número que está no WhatsApp **pessoal** não pode ser conectado como está. Migre para o app WhatsApp Business primeiro (as conversas são mantidas) e siga o Caso A, ou use um número livre.
- Para usar o número **só** pelo Dish Desk, ele não pode estar ativo em nenhum app do WhatsApp. Se estiver, apague a conta nesse aparelho antes. **Isso apaga as conversas do aparelho e o número deixa de funcionar no app.**
- A Meta confirma o número com um código por SMS ou ligação.

## Conectando

1. Entre em `https://www.dishdesk.com.br/login` e escolha o restaurante.
2. Vá em **Configurações → Integrações**.
3. No card **WhatsApp Business API**, clique em **Conectar** e depois em **Conectar o WhatsApp**.
4. Na janela da Meta:
   - Entre com o seu Facebook.
   - Escolha (ou crie) a **conta comercial** do restaurante.
   - Escolha (ou crie) a **conta do WhatsApp Business**.
   - Informe o número e confirme pelo QR code ou pelo código.
   - Conclua.
5. De volta ao Dish Desk, o card mostra o **número conectado**.
6. Teste: de outro celular, mande uma mensagem para o número. Ela deve aparecer na **Inbox** em poucos segundos. Responda e confira se chega.

## Depois de conectar

- **Nome de exibição:** a Meta precisa aprovar o nome que os clientes veem. Use o nome real do restaurante. Até a aprovação, o nome aparece como pendente.
- **Forma de pagamento:** necessária para enviar mensagens iniciadas pelo restaurante (modelos fora das 24h). Cadastre na conta do WhatsApp, no Gerenciador do WhatsApp. Responder um cliente que escreveu nas últimas 24h não exige isso.
- **Modelos de mensagem:** os modelos aprovados aparecem no botão **Template** da conversa.

## Limites atuais

- Enquanto o app Dish Desk não passar pela **análise da Meta**, só quem tem papel no app (administrador, desenvolvedor ou testador) consegue concluir a conexão. Clientes reais só depois da aprovação.
- Mensagens enviadas pelo **celular** e o **histórico antigo** ainda não aparecem na Inbox do Dish Desk.
- Cada número só pode estar ligado a **um** restaurante.

## Problemas comuns

| Mensagem ou sintoma | O que fazer |
|---|---|
| "Esta conta já está conectada a outro restaurante" | O número já foi conectado em outro restaurante. Desconecte lá primeiro, ou fale com o suporte. |
| A janela da Meta não abre | Libere pop-ups para `dishdesk.com.br` e tente de novo. |
| A janela abre, mas o número não aparece | O número ainda está num WhatsApp comum. Veja o Caso B. |
| A mensagem do cliente chega, mas a resposta falha | Veja o motivo exato no balão da mensagem. Se for restrição por país, pode ser temporária. Tente de novo mais tarde. |
