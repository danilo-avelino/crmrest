## Rodada "antes"

Modelo: claude-haiku-5-5 (parâmetros da produção). Juiz: claude-sonnet-5-5. Custo: US$ 0.494.

**Acerto: 135/174 respostas (78%). Nota média do juiz: 3.69** (correção 3.84, não inventa 4.10, tom 3.55, concisão 3.66).

| Categoria | Casos | Acerto | Nota |
|---|--:|--:|--:|
| info-fora-dos-dados | 7 | 10/21 | 3.00 |
| alergia | 3 | 8/9 | 4.67 |
| extra-no-pedido | 5 | 13/15 | 3.20 |
| andamento | 7 | 15/21 | 3.57 |
| pedido-nao-achado | 4 | 9/12 | 3.50 |
| cumprimento-e-pedido | 4 | 12/12 | 4.50 |
| loja-fechada | 6 | 13/18 | 3.50 |
| app-mostra-fechado | 2 | 2/6 | 2.00 |
| reclamacao | 4 | 11/12 | 4.25 |
| recado-e-entrega | 4 | 12/12 | 3.75 |
| entregador | 2 | 5/6 | 3.00 |
| spam-fornecedor | 3 | 6/9 | 4.33 |
| despedida | 3 | 8/9 | 4.00 |
| cardapio-e-pedido | 4 | 11/12 | 4.50 |

### Falhas

**barca-50-pecas** (info-fora-dos-dados, 0/3 ok). Esperado: Barca não está nos DADOS: chama a equipe sem dizer se tem ou não. Links são opcionais.
- #1 handoff false: "Consigo sim, mas quem monta o pedido é a loja pelo link. Pode fazer pelo Sushi Mar Azul: https://pedir.exemplo.com/sushimarazul. Lá estão o cardápio e os preços. Quer que eu chame um atendente para te ajudar com a barca?"
  - handoff false, esperado true; frase proibida "Consigo sim"; juiz 2: Barca de 50 peças não está nos DADOS e deveria ir para a equipe (handoff=true) sem confirmar. A resposta diz "Consigo sim", o que afirma algo inventado, e não aciona handoff, só oferece chamar um atendente.
- #2 handoff false: "Consigo sim, o sushi é pelo Sushi Mar Azul. Pelo link você monta o pedido e vê o cardápio e os preços: https://pedir.exemplo.com/sushimarazul. Quer que eu chame um atendente para te ajudar com a quantidade?"
  - handoff false, esperado true; frase proibida "Consigo sim"
- #3 handoff false: "Consigo sim, mas não anoto pedidos por aqui. Você pode fazer o pedido pelo link do Sushi Mar Azul 🍣: https://pedir.exemplo.com/sushimarazul. Lá estão o cardápio e os preços, e a loja está aberta agora. Quer que eu chame um atendente para ajudar com a barca de 50 peças?"
  - handoff false, esperado true; frase proibida "Consigo sim"

**combo-36-retirada** (info-fora-dos-dados, 1/3 ok). Esperado: Os links já foram mandados. O combo não está nos DADOS: chama a equipe, sem afirmar que existe nem mandar os links de novo.
- #2 handoff false: "Esse combo de 36 unidades vai ser pelo mesmo link que já te mandei, escolhendo a opção de retirada lá. O cardápio e os preços estão nos links, então dá para ver o combo certinho por lá. Se quiser, chamo um atendente para te ajudar com isso."
  - handoff false, esperado true
- #3 handoff false: "Esse combo de 36 unidades a gente não consegue montar por aqui, então pode fazer direto pelos links que já mandei. Lá você escolhe o combo e a opção de retirada. Se preferir, posso chamar um atendente para te ajudar."
  - handoff false, esperado true

**pizza-8-fatias** (info-fora-dos-dados, 0/3 ok). Esperado: O número de fatias não está nos DADOS: chama a equipe sem responder sim ou não.
- #1 handoff false: "Boa noite, Carla! Não tenho os detalhes das pizzas aqui, mas o cardápio com sabores e preços está neste link: https://forno-nero.exemplo.com/?s=wpp. Quer que eu chame um atendente para tirar essa dúvida das fatias?"
  - handoff false, esperado true; juiz 2: Não chamou a equipe (handoff=false), apenas ofereceu chamar. Mandou o link do cardápio sem necessidade e expôs que não sabe ('Não tenho os detalhes'). O correto era handoff=true, sem responder sim ou não.
- #2 handoff false: "Boa noite, Carla! Não tenho os detalhes das pizzas aqui, então não consigo confirmar quantas fatias tem a grande. No cardápio, que está no link https://forno-nero.exemplo.com/?s=wpp , você encontra os sabores e os preços. Quer que eu chame um atendente para tirar essa dúvida?"
  - handoff false, esperado true
- #3 handoff false: "Boa noite, Carla! Não tenho os detalhes dos produtos aqui, então não consigo confirmar quantas fatias tem a grande. No cardápio estão os tamanhos e os preços: https://forno-nero.exemplo.com/?s=wpp. Quer que eu chame um atendente para tirar essa dúvida?"
  - handoff false, esperado true

**consumo-no-local** (info-fora-dos-dados, 0/3 ok). Esperado: Consumo no local não está nos DADOS: chama a equipe, sem dizer que pode ou não pode e sem expor o que a IA não sabe.
- #1 handoff false: "Hoje não dá para pedir para comer no local por aqui, mas você pode fazer seu pedido para entrega ou retirada pelos nossos links: Sushi Mar Azul 🍣: https://pedir.exemplo.com/sushimarazul, Casa Verde ☘️: https://casaverde.exemplo.com/pedido?s=wpp e Forno Nero Pizzaria 🍕: https://forno-nero.exemplo.com/?s=wpp. Lá estão o cardápio e os preços."
  - handoff false, esperado true; juiz 1: Consumo no local não está nos DADOS e deveria ir para a equipe (handoff=true). A resposta afirmou que não dá para comer no local, inventando uma política, e mandou links sem necessidade, sem chamar a equipe.
- #2 handoff true: "Não tenho essa informação aqui, então vou chamar alguém da equipe para confirmar se dá para pedir para comer no local."
  - frase proibida "Não tenho essa informa"
- #3 handoff true: "Não tenho essa informação aqui para te responder com segurança. Já há alguém da equipe online, então vou passar para ela continuar o atendimento e te responder sobre pedido para consumir no local."
  - frase proibida "Não tenho essa informa"

**ingrediente-cebola** (alergia, 2/3 ok). Esperado: Restrição alimentar: passa para a equipe, sem dizer se o prato tem o ingrediente.
- #3 handoff true: "Boa noite, Bruno! Não consigo dizer se a calabresa leva cebola, então vou chamar alguém da equipe para confirmar isso com você."
  - frase proibida "leva cebola"

**extra-lista-molhos** (extra-no-pedido, 2/3 ok). Esperado: Itens para vir junto com o pedido: observação para a equipe, nunca link de pedido novo.
- #1 handoff true: "Boa noite, Paulo! 😊 Esses itens a gente não consegue anotar por aqui, então já passei para a equipe, que vai ver o seu pedido. Enquanto isso, se quiser fazer um pedido novo, o cardápio está em https://loja.exemplo.com/sushimarazul"
  - frase proibida "https://"; juiz 2: Chamou a equipe (handoff correto), mas ofereceu o link do cardápio para pedido novo, o que o caso proíbe expressamente. Também disse que "não consegue anotar", o que expõe limitação e confunde; o certo era avisar que passou como observação para a equipe.

**mudanca-meio-a-meio** (extra-no-pedido, 2/3 ok). Esperado: Pedido identificado pelo número: não pergunta se é dele. Mudança no pedido vai para a equipe, sem dizer se dá.
- #1 handoff false: "Boa noite, Gustavo! Seu pedido #274 já consta como recebido. Não sei dizer se a pizza pode ser meio a meio, e prefiro não chutar. Os sabores e as opções estão no cardápio: https://forno-nero.exemplo.com/?s=wpp. Quer que eu chame um atendente para ver isso com você?"
  - handoff false, esperado true; frase proibida "https://"; juiz 2: Mudança no pedido deveria ir para a equipe com handoff=true. Em vez disso, perguntou se quer chamar atendente (handoff=false), expôs que não sabe e mandou o cardápio, o que sugere novo pedido. Também marcou order=confirmed sem necessidade.

**andamento-cardapio-web-numero** (andamento, 0/3 ok). Esperado: O cliente deu o número: diz o andamento logo, sem pedir confirmação. O nome do perfil (jrsn) não é nome de pessoa: cumprimenta sem ele.
- #1 handoff false: "Boa noite, Jrsn! Seu pedido #273 (1x Pizza de dois sabores, total R$ 70,93) já está na cozinha, e a previsão de saída do restaurante é por volta das 20:15. Tem 1 pedido na sua frente, então a previsão pode mudar conforme a cozinha anda."
  - frase proibida "Jrsn"; juiz 2: Deu o andamento sem pedir confirmação, mas cumprimentou com "Jrsn", que a nota do caso manda omitir por não ser nome de pessoa. Também disse que o pedido "já está na cozinha", o que não consta nos DADOS (só "recebido"), e repetiu itens e total sem necessidade.
- #2 handoff false: "Boa noite, Jrsn! Seu pedido #273 (1x Pizza de dois sabores, total R$ 70,93) está recebido e ainda não saiu, mas a previsão de saída do restaurante é por volta das 20:15. Tem 1 pedido na sua frente na cozinha, então a fila pode mudar conforme a cozinha anda."
  - frase proibida "Jrsn"
- #3 handoff false: "Boa noite, Jrsn! Beleza, Jean, o seu pedido #273 (1x Pizza de dois sabores, total R$ 70,93) está recebido e a previsão de saída do restaurante é por volta das 20:15. Tem 1 pedido na sua frente na cozinha, então a fila pode mudar conforme a cozinha anda."
  - frase proibida "Jrsn"

**andamento-confirma-pelo-uso** (andamento, 0/3 ok). Esperado: Perguntar a hora do pedido mostrado confirma: order = confirmed e dá o andamento sem perguntar de novo.
- #1 handoff false: "Só falta confirmar: é esse o pedido, o #6850 com 1x Arrumadinho? Se for, a previsão é que ele saia do restaurante por volta das 12:25."
  - order none, esperado confirmed; frase proibida "confirm"; juiz 2: A nota do caso pede tratar "Que hora vem?" como confirmação (order = confirmed) e dar o andamento direto. A resposta devolveu a pergunta de confirmação e deixou order = none, repetindo o que já fora dito. Também entregou a previsão antes de o cliente confirmar.
- #2 handoff false: "Esse pedido é o seu, então? Se for, a previsão é de sair do restaurante por volta das 12:25."
  - order none, esperado confirmed
- #3 handoff false: "A previsão é de sair do restaurante por volta das 12:25. Esse é o pedido com 1x Arrumadinho que você fez?"
  - order none, esperado confirmed

**pedido-nao-achado-numero-errado** (pedido-nao-achado, 0/3 ok). Esperado: Já veio com o número e o pedido não está nos DADOS: passa para a equipe, sem pedir o número de novo nem dizer que não aparece.
- #1 handoff false: "Boa tarde, Rafael! Pode me passar o número do pedido, por favor? Se o telefone usado no pedido for diferente deste, também me avise."
  - handoff false, esperado true; juiz 1: O cliente já informou o número (1197) e o pedido não está nos DADOS. O correto era passar para a equipe (handoff=true). A resposta pediu o número de novo e não fez handoff, ignorando o que o cliente disse.
- #2 handoff false: "Boa tarde, Rafael! Pode me passar o número do pedido completo, por favor? Assim confiro o andamento para você."
  - handoff false, esperado true
- #3 handoff false: "Boa tarde, Rafael! Pode me passar o telefone usado no pedido? Assim consigo localizar ele aqui."
  - handoff false, esperado true

**pausa-link-mostra-fechado** (loja-fechada, 1/3 ok). Esperado: Confirma que o site mostra certo: a loja está fechada pela falta de energia. Não repete o aviso inteiro, não manda link.
- #1 handoff false: "Entendi, Vívian, mas a loja está fechada agora por falta de energia e ainda não tem previsão de volta, então não dá pra pedir pelos links por enquanto. Assim que o atendimento voltar, você consegue fazer o pedido pelo cardápio: https://loja.exemplo.com/sushimarazul 🍣"
  - frase proibida "https://"; juiz 2: Confirma que o site está certo, mas repete o aviso inteiro (falta de energia, sem previsão) e manda o link do cardápio, o que o caso e os DADOS proíbem. Também fica longa para a situação.
- #2 handoff false: "Entendo, Vívian, mas a loja está fechada agora por falta de energia e ainda não tem previsão de volta, então por enquanto não dá para pedir pelos links. Assim que o atendimento voltar, você consegue pedir pelo cardápio: https://loja.exemplo.com/sushimarazul 🙌"
  - frase proibida "https://"

**pausa-com-volta** (loja-fechada, 2/3 ok). Esperado: Pausa com volta às 20:30: diz que está fechado pela falta de energia e volta às 20:30.
- #1 handoff false: "Oi, Clara! 😊 A loja está fechada agora por falta de energia, e o atendimento volta hoje às 20:30. Os horários normais são das 16:00 às 23:00 todos os dias. Assim que voltar a funcionar, você já pode fazer o pedido pelo cardápio: https://loja.exemplo.com/sushimarazul"
  - frase proibida "16:00"; juiz 3: Explica a falta de energia e a volta às 20:30, mas não usa o cumprimento exigido ("Boa noite, Clara!") e envia o link do cardápio durante a pausa, o que os DADOS proíbem. O horário normal é extra e desnecessário.

**pausa-quer-pedir-assim-mesmo** (loja-fechada, 1/3 ok). Esperado: Não aceita pedido nem manda links durante a pausa: está fechado por falta de energia.
- #1 handoff false: "Boa noite, Marina! No momento a loja está fechada por falta de energia, e ainda não há previsão de volta. Por isso não dá para fazer pedido agora pelos links, mas assim que o atendimento voltar você pode pedir normalmente. Se preferir, a conversa pode ser encaminhada para a equipe quando o restaurante abrir."
  - frase proibida "pode pedir"; juiz 5: Responde logo após o cumprimento que não dá para pedir agora, explica a falta de energia, não inventa previsão e não manda links. A oferta final de encaminhar para a equipe é desnecessária, mas é pouco prejudicial.
- #3 handoff false: "Boa noite, Marina! No momento a loja está fechada por falta de energia, e ainda não há previsão de volta. Por isso não dá para fazer pedido agora pelos links, mas assim que o atendimento voltar você pode pedir normalmente."
  - frase proibida "pode pedir"

**fora-do-horario-entre-turnos** (loja-fechada, 3/3 ok). Esperado: Entre os turnos: fechado agora, abre hoje às 16:00 (sem dizer que hoje não abre).
- #1 handoff false: "Boa tarde, Marcos! Hoje a gente já está fechado no momento, mas abrimos às 16:00. Até lá, os pedidos podem ser feitos pelos nossos links: Sushi Mar Azul 🍣: https://pedir.exemplo.com/sushimarazul; Casa Verde ☘️: https://casaverde.exemplo.com/pedido?s=wpp; Forno Nero Pizzaria 🍕: https://forno-nero.exemplo.com/?s=wpp"
  - juiz 2: Diz "Hoje a gente já está fechado", que o caso proíbe, e manda pedir pelos links com a loja fechada, o que é proibido. Também sugere que os pedidos feitos até as 16h valem, o que não consta nos DADOS. O certo era dizer "abrimos às 16:00".

**google-mostra-fechado-mas-aberto** (app-mostra-fechado, 1/3 ok). Esperado: Pelos DADOS está aberto: diz isso e o horário, sem inventar a causa do Google estar diferente.
- #1 handoff false: "Boa tarde, Amábile! O horário certo é o que está aqui: hoje, segunda, abrimos das 11:00 às 15:00 e das 16:00 às 23:00, e agora estamos abertos. Se o Google mostrou outra coisa, pode ser só uma informação desatualizada por lá."
  - frase proibida "pode ser"; frase proibida "desatualizad"; juiz 3: Acertou ao dizer que está aberto e informar o horário, sem handoff. Mas a última frase sugere uma causa para o Google ('informação desatualizada'), o que a nota do caso proíbe: não inventar a causa da divergência.
- #2 handoff false: "Boa tarde, Amábile! Pode ficar tranquila, o Casa Verde está aberto agora. Hoje funcionamos das 11:00 às 15:00 e das 16:00 às 23:00. O Google deve estar desatualizado, então pode confiar nesse horário."
  - frase proibida "desatualizad"

**app-mostra-fechado-mas-aberto** (app-mostra-fechado, 1/3 ok). Esperado: Não consegue pedir pelo link: chama a equipe, sem inventar a causa e sem insistir que está aberto nem mandar o link de novo.
- #1 handoff false: "Oi! Que chato, né? 😕 A loja está aberta agora, até as 23:00. Você consegue tentar pelo link de novo: https://loja.exemplo.com/sushimarazul. Se aparecer como fechado, me avisa que chamo alguém da equipe para ver isso com você! 🙌"
  - handoff false, esperado true; frase proibida "https://"; juiz 1: Deveria chamar a equipe (handoff true), mas manteve handoff false, insistiu que a loja está aberta e mandou o link de novo, o que o caso proíbe. Também cumprimentou de novo com "Oi!" e empurrou o cliente a tentar sozinho.
- #2 handoff false: "Oi! Estamos abertos sim, até as 23:00 hoje 😊 Me conta, o que apareceu quando você tentou pedir? Se preferir, posso chamar alguém da equipe para resolver isso com você agora! 🙌"
  - handoff false, esperado true; frase proibida "Estamos abertos sim"

**atraso-reclama-depois-do-andamento** (reclamacao, 2/3 ok). Esperado: Continua reclamando depois do andamento: reconhece a demora e chama a equipe, sem repetir a previsão.
- #1 handoff true: "Sinto muito pela demora, Samara. Pelo que temos aqui, a previsão de saída continua por volta das 19:50, e a equipe já vai ver o seu caso."
  - frase proibida "19:50"; juiz 3: Reconhece a demora e chama a equipe (handoff true), como pede o caso. Mas repete a previsão das 19:50, que o caso manda não repetir, e isso deixa a resposta mais longa e pouco empática diante da reclamação.

**recado-interfone** (recado-e-entrega, 3/3 ok). Esperado: Recado ao entregador: passa para a equipe, sem prometer que o entregador vai mandar mensagem.
- #1 handoff true: "Boa noite, Eduardo! Seu pedido #2531 já está pronto, e a previsão de saída do restaurante é por volta das 21:20. Não consigo ver a localização do entregador nem a hora exata em que ele chega, mas vou enviar aqui as atualizações que ainda faltam, quando sair e quando for entregue. Como o interfone não está funcionando, alguém da equipe já vai continuar o atendimento para combinar com você como fazer a entrega chegar até você."
  - juiz 2: Acertou o handoff, mas não responde direto ao pedido do recado na primeira frase e promete "enviar atualizações quando sair e for entregue", sem base nos DADOS. Também é longa, com explicações desnecessárias e tom de assistente.

**entregador-avisa-cliente** (entregador, 2/3 ok). Esperado: Quem escreve é o entregador: diz que alguém da equipe já vai falar com ele, courier = true, handoff = true.
- #1 handoff true: "Boa tarde, Wesley! Há alguém da equipe online, e ela já vai continuar o atendimento por aqui sobre o pedido 3203."
  - courier false, esperado true; juiz 2: A pessoa que escreve é o entregador (avisa que está na portaria), mas a resposta marcou courier=false e tratou como cliente. O handoff=true está certo. Ficou sem naturalidade ('Há alguém da equipe online, e ela já vai...') e não diz o que foi pedido.

**spam-consultoria** (spam-fornecedor, 0/3 ok). Esperado: Oferta de serviço: uma frase dizendo que o canal é do atendimento aos clientes, sem dizer se há interesse. Não usa o nome do perfil (não é de pessoa).
- #1 handoff false: "Boa noite, Assistente! Este canal é para o atendimento dos clientes do restaurante, então não consigo tratar desse assunto por aqui."
  - frase proibida "Assistente"; juiz 3: Disse que o canal é do atendimento aos clientes e não demonstrou interesse, o que combina com o caso. Mas usou "Assistente" no cumprimento, e o nome do perfil não é de pessoa. Também acrescentou "não consigo tratar desse assunto", que soa mais como recusa do que como a frase simples esperada.
- #2 handoff false: "Boa noite, Assistente! Este canal é para o atendimento dos clientes do restaurante, então não conseguimos falar sobre essa proposta por aqui."
  - frase proibida "Assistente"
- #3 handoff false: "Boa noite, Assistente! Este canal é para o atendimento dos clientes do restaurante, então não consigo tratar desse assunto por aqui."
  - frase proibida "Assistente"

**ok-depois-do-andamento** (despedida, 2/3 ok). Esperado: Só confirmou: no máximo uma frase curta, sem repetir a previsão.
- #2 handoff false: "Beleza, a previsão continua por volta das 19:55. Assim que sair eu mando aqui 👊"
  - frase proibida "19:55"

**pedido-novo-links** (cardapio-e-pedido, 2/3 ok). Esperado: Pedido novo: manda os links com o endereço completo, sem cumprimentar de novo.
- #2 handoff false: "Claro, você quer pedir de qual restaurante? Pelos links, temos o Sushi Mar Azul, a Casa Verde e o Forno Nero Pizzaria. Pode me dizer qual deles, ou se prefere que eu chame um atendente."
  - falta /https:///
