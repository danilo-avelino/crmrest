# Análise do app (Meta App Review) — textos para colar

App: **Dish Desk** (ID 2180763739519173, portfólio Dish Desk). Os textos estão em inglês, o idioma que os avaliadores leem com mais segurança. Cada bloco vai no campo "How will this app use this permission?" da permissão correspondente.

Peça **somente** estas quatro permissões. O Dish Desk não usa comentários do Instagram, e a Meta recusa permissões que o vídeo não mostra em uso.

---

## Descrição geral do app (campo "App description" / "Platform details")

> Dish Desk is a customer service inbox (CRM) for restaurants in Brazil. A restaurant connects its Instagram professional account and its WhatsApp Business number, and its team answers every customer conversation from one shared inbox at www.dishdesk.com.br. Incoming messages arrive through webhooks; the team replies from the inbox, and simple automations (greeting menu, order status lookup, satisfaction survey) answer common questions. Each restaurant only sees its own customers. Dish Desk is a web app used by restaurant staff; customers keep using Instagram and WhatsApp as usual.

---

## instagram_business_basic

> Dish Desk is a customer service inbox for restaurants. We request instagram_business_basic only as a dependency of instagram_business_manage_messages, which is the feature we offer: answering customers' Instagram Direct messages.
>
> How we use it: when a restaurant connects its Instagram professional account through Instagram Business Login, we read the account's user ID and username to link it to that restaurant, route its incoming Direct messages to the right inbox and show which account is connected. When a customer sends a DM, we read that customer's name and username to show them next to the conversation. Dish Desk does NOT publish anything: no posts, stories, reels or comments. We also do not read the account's media or insights.
>
> How to test: log in at https://www.dishdesk.com.br/login with the reviewer credentials in the testing instructions and choose the restaurant "Revisão Meta". Go to Configurações (Settings) > Integrações (Integrations), click "Conectar" (Connect) on the Instagram card and then "Conectar o Instagram" (Connect Instagram), and authorize with your own Instagram professional account. Back in Dish Desk, the Instagram card shows the username of the connected account. After a customer sends a DM, their name and username appear on the conversation in "Inbox".

## instagram_business_manage_messages

> Dish Desk is a customer service inbox for restaurants. We use instagram_business_manage_messages so a restaurant's team can receive and answer the Instagram Direct messages that customers send to the restaurant (questions about the menu, opening hours, orders), together with its other channels, in one shared inbox.
>
> How we use it: when a customer sends a DM to the restaurant's connected Instagram professional account, our webhook receives it and the conversation appears in the Dish Desk inbox. A staff member reads it and replies, and the reply is sent back to the customer through the Instagram API. Simple automated replies (a greeting menu and order status answers) are only sent within the 24-hour messaging window, in response to a message from the customer. We never send unsolicited or promotional messages. Dish Desk only handles Direct messages: it does NOT publish posts, stories, reels or comments.
>
> How to test: after connecting an Instagram professional account (see instagram_business_basic), send a Direct message to that account from another Instagram account. The message appears in "Inbox" within a few seconds. Open the conversation, type a reply and press "Enviar" (Send). The reply arrives in the customer's Instagram Direct.

---

## whatsapp_business_messaging

> Dish Desk uses whatsapp_business_messaging to receive and send WhatsApp messages on behalf of restaurants that connect their WhatsApp Business number. Customer messages arrive through our webhook and appear in the Dish Desk inbox; restaurant staff reply from the inbox, and the replies are sent through the WhatsApp Cloud API. Automations answer common questions (opening hours, order status) inside the 24-hour customer service window. Outside that window we only send message templates approved by Meta.
>
> How to test: log in at https://www.dishdesk.com.br/login with the test credentials provided and connect a WhatsApp number (see whatsapp_business_management). Send a WhatsApp message to that number from another phone. The message appears in "Inbox"; open it and send a reply, which arrives on WhatsApp.

## whatsapp_business_management

> Dish Desk uses whatsapp_business_management when a restaurant connects its WhatsApp Business account through Embedded Signup: to read the phone numbers of the WhatsApp Business Account (display number and verified name), register the selected number on the Cloud API, subscribe our app to the account's webhooks so we receive its messages, and list the account's approved message templates so staff can send them from the inbox. We do not create or edit templates and do not manage billing.
>
> How to test: in Configurações → Integrações, click "Conectar" on the "WhatsApp Business API" card and then "Conectar o WhatsApp", and complete Embedded Signup with a test WhatsApp Business account. The connected number then appears in the WhatsApp card. In a WhatsApp conversation, the "Template" button lists the account's approved templates.

---

## Instruções para o avaliador — envio só do Instagram (outubro de 2026)

Enquanto o portfólio Dish Desk estiver bloqueado no WhatsApp, o envio leva só `instagram_business_basic` e `instagram_business_manage_messages` (com o `public_profile`, que é automático). Use este texto no lugar do bloco seguinte:

> 1. Open https://www.dishdesk.com.br/login and log in with the reviewer credentials below.
> 2. Choose the restaurant "Revisão Meta". It contains only fictitious test data.
> 3. Go to Configurações → Integrações, click "Conectar" on the Instagram card and then "Conectar o Instagram" (Instagram Business Login). Authorize with an Instagram professional account.
> 4. Send a Direct message to the connected account from another Instagram account. It appears in Inbox in a few seconds; open the conversation, type a reply and press send. The reply arrives in the customer's Instagram Direct.
>
> Login: [e-mail do usuário de teste]
> Password: [senha do usuário de teste]
>
> The interface is in Portuguese. Key labels: "Configurações" = Settings, "Integrações" = Integrations, "Conectar" = Connect, "Conectar o Instagram" = Connect Instagram, "Inbox" = Inbox, "Enviar" = Send.

## Instruções para o avaliador (campo "Testing instructions")

> 1. Open https://www.dishdesk.com.br/login and log in with the reviewer credentials below.
> 2. Choose the restaurant "Revisão Meta". It contains only fictitious test data.
> 3. Go to Configurações → Integrações and click "Conectar" on the Instagram card (Instagram Business Login) or on the "WhatsApp Business API" card (Embedded Signup).
> 4. Send a message to the connected account from another account. It appears in Inbox in a few seconds; reply from the conversation.
>
> Login: [e-mail do usuário de teste]
> Password: [senha do usuário de teste]
>
> The interface is in Portuguese. Key labels: "Configurações" = Settings, "Integrações" = Integrations, "Conectar" = Connect, "Conectar o Instagram" = Connect Instagram, "Conectar o WhatsApp" = Connect WhatsApp, "Inbox" = Inbox, "Enviar" = Send, "Template" = Message template.
