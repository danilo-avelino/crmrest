# Plano de qualidade da IA de atendimento

25/11/2026. Análise do atendimento com IA (`apps/api/src/ai/`) e de uma amostra dos logs de 21 a 24/11. Só análise e proposta: nenhum código foi mudado. Preços conferidos na referência da API do Claude (cache de 03/11/2026).

## 1. Como funciona hoje

**Uma chamada por resposta.** `AiAttendantService.reply` monta duas mensagens (`attendantMessages`) e chama `LlmClient.json` uma vez. Só repete se o JSON vier quebrado (raro com saída estruturada). Antes, cada resposta tenta a principal (`AI_BASE_URL`, o túnel do Ollama desligado desde 09/11), que falha em ~0,5 s, e cai na reserva: Claude Haiku 5.5, com `effort: "low"` e raciocínio adaptativo (ligado por padrão no Haiku 5.5).

**O que vai no prompt** (estimado pelos caracteres; o tokenizador do Haiku 5.5 conta cerca de 30% a mais que o do Haiku 4.5):

| Parte | Tamanho | Muda por |
|---|---|---|
| System: identidade, personalidade com 4 exemplos, regras de escrita e de estilo, ~60 regras de atendimento, passo a passo do pedido e de quando chamar a equipe | ~14,5 mil caracteres, ~4,5 a 5,5 mil tokens | restaurante (nome e tom) e canal (regras do iFood e do entregador, pedido do telefone) |
| DADOS: horário, aberto ou fechado, pausas, links, cumprimento, atendentes, pedido e andamento | ~0,6 a 1 mil tokens | cada resposta |
| CONVERSA: até 30 mensagens das últimas 12 h | ~0,2 a 1,5 mil tokens | cada resposta |
| Saída: JSON (reply, handoff, reason, order, skip, courier) e o raciocínio | ~200 a 400 tokens | cada resposta |

**Sem cache do prompt.** `completeClaude` manda o system como texto simples, sem `cache_control`. O nome do restaurante está na primeira linha, e as regras do canal ficam no meio, então nem um cache por restaurante pegaria o bloco inteiro. Só o agente do cardápio (`llm-provider.ts`) usa cache.

**Custo.** Cerca de US$ 0,0008 por resposta (6,5 mil tokens de entrada a US$ 0,10/M e 350 de saída a US$ 0,50/M). Os logs mostram de 57 a 109 respostas da IA por dia somando todos os restaurantes: cerca de 2.500 por mês, ou **US$ 2 por mês**. A tela Plataforma → Gastos com IA soma por provedor e por restaurante, mas o `AiUsage` não guarda o tipo de chamada (atendimento, revisão, sugestão), então o custo por resposta não dá para separar no banco: é estimativa.

**Conclusão:** o custo não é o limite. A IA é barata o bastante para triplicar o gasto sem pesar. Mais contexto só pesa se trocar de modelo sem cache.

## 2. O que dá errado nos logs (21 a 24/11)

Cerca de 300 respostas da IA nos quatro dias. Agrupei o que se repete:

| Padrão | Exemplos (sem dados de cliente) | Causa |
|---|---|---|
| Loja fechada que a IA diz aberta | 23/11, falta de energia: 9 clientes ouviram "estamos abertos"; avaliações de 44 a 70 | **Falta de dado.** Já corrigido no código ainda sem commit (pausa da loja em Configurações → Horário) |
| Pergunta sobre o cardápio ou a casa que só a equipe sabia | barca de 50 peças, combo de 36, pizza de 8 fatias, hashi com liga, talher, castanha (alergia), consumo no local, área de entrega, cupom, chave esquecida | **Falta de dado.** A equipe respondeu em seguida ("só hashi", "barca descartável R$ 10", "pedidos só pelo link") e a IA não aprende isso |
| Grupo com 3 marcas: manda os 3 links para quem já pediu de uma | cliente da pizzaria recebe os links das três lojas | **Falta de dado:** a IA não sabe a marca do pedido |
| Nome estranho no cumprimento | "Boa noite, Eng!", "Nutri", "Jrsn", "Cl", "Vb"; pedido com o nome "Neemo" citado ao cliente | **Falta de dado limpo:** dá para filtrar no código |
| Inventa causa ou previsão | "pode ser uma atualização deles", "o sistema pode mostrar fechado por engano", "pelo tempo normal já deve ter saído", "chega logo", "hoje a gente tem sim" (a barca), "o entregador não passou pelo balão" | **Modelo fraco** com esforço baixo: a regra existe ("nunca invente... nem a causa de um problema") |
| Diz que não achou o pedido | "não aparece aqui no nosso sistema", "não encontrei nenhum pedido seu" | **Modelo fraco:** a proibição aparece três vezes no prompt |
| Responde "Em que posso ajudar?" quando o cliente já disse | "Quando sair pra entrega por favor avise" → "Em que posso ajudar?"; "no aguardo"; "Ok" | **Regra mal escrita:** a regra do cumprimento (nos DADOS) pesa mais que "responda a tudo" |
| Recado ou item extra tratado como pedido novo | "traz 2 hashis com liga" → link para novo pedido; "podem enviar 2 hashis, molho..." → idem | **Regra conflitante:** "você não anota pedidos, mande os links" contra "mudança no pedido (observação, item) vai para a equipe" |
| Não chama a equipe quando devia | "estou na porta e ele não chegou" depois do aviso de chegada → "ele já deve estar aí" | **Modelo fraco / falta de exemplo:** a regra existe |
| Repete o andamento depois de "ok" e "tudo bem" | três vezes a mesma previsão na mesma conversa | **Modelo fraco:** `ANDAMENTO_RULE` diz para não repetir |
| Pede confirmação de novo ou dá o andamento antes dela | "Que hora vem?" (isso confirma, pela regra) → pergunta de novo; andamento dado antes do "sim" | **Regra complexa demais** para o modelo |
| Fórmulas proibidas e textos longos | "Entendi, você quer...", respostas de 4 ou 5 frases que se contradizem | **Falta de exemplo:** o estilo é descrito, não mostrado |
| Entregador com a tag atendido pela IA | entregador com a tag Entregador recebeu "não encontrei pedido" e um link de pedido | **Bug a conferir** (a tag deveria tirar a IA) |

**Dois achados sobre o aprendizado:**
- A avaliação diária (Jev) só roda quando a equipe respondeu. Conversa atendida só pela IA vira `aiOnlyAttendance`, sem nota. Vários dos piores casos acima (previsão inventada, hashi tratado como pedido) **não têm avaliação**.
- A avaliação dá nota, problema e culpa do atendimento inteiro, sem dizer qual mensagem errou nem o que deveria ter sido dito. Sozinha, não vira regra.

**Resumo da causa:** quase metade é falta de dado (o que a casa sabe e a IA não). O resto é instrução que o Haiku não segue num prompt longo, remendado caso a caso, com regras que se contradizem. Modelo maior resolveria parte do segundo grupo, mas nada do primeiro.

## 3. Opções

Base: ~2.500 respostas por mês, ~6,5 mil tokens de entrada (5 mil fixos) e ~350 de saída. Os preços são da API (Haiku 5.5 US$ 0,10 / 0,50 por milhão; Sonnet 5.5 US$ 2 / 10; Opus 5.5 US$ 4 / 20; leitura do cache 0,1x no Haiku e US$ 0,10/M no Sonnet; gravação 1,25x; mínimo de 512 tokens para cachear). Os ganhos são estimativas até a medição do item A.

| # | Opção | Custo por resposta | Por mês | Ganho esperado | Esforço |
|---|---|--:|--:|---|---|
| — | Hoje (Haiku, esforço baixo, sem cache) | US$ 0,0008 | US$ 2 | — | — |
| A | **Conjunto de teste** com ~50 casos reais dos logs e a resposta esperada; o `AiUsage` passa a gravar o tipo da chamada | US$ 0,04 por rodada | — | Mede tudo o que vem depois; sem ele, cada ajuste volta a ser um remendo | P |
| B | **Cache do bloco fixo:** regras iguais para todos os restaurantes primeiro, com `cache_control`; nome, tom e regras do canal vão para depois (ou para os DADOS) | US$ 0,0004 | US$ 1 | −55% de entrada; principalmente, abre espaço para B, D e E sem custo | P |
| C | **Travas no código:** frase proibida ("não encontrei", "não aparece", "deve ser", "pode ser que", "já deve ter saído", "chega logo") pede de novo uma vez, com o motivo; "alerg" força a passagem para a equipe; nome que não é de pessoa sai do cumprimento; só o link da marca do pedido | +US$ 0,0001 (repetição em ~10%) | +US$ 0,25 | Corta os erros mais graves que o modelo não segue | P |
| D | **Reescrever o prompt** como tabela situação → ação, sem duplicatas nem conflitos, com 8 a 12 exemplos curtos de resposta boa (cumprimento + pedido junto, recado ao entregador, item extra, "estou na porta", "ok" depois do andamento) dentro do bloco em cache | ~igual a B | ~US$ 1 | Alto nos padrões de regra e de estilo | M |
| E | **Respostas da casa por restaurante:** um job semanal lê as conversas em que a IA chamou a equipe e a equipe respondeu uma dúvida ("só hashi", "barca descartável R$ 10", "consumo no local não"), propõe frases curtas, e o dono aprova em Configurações. Entram num segundo bloco em cache, com teto de ~600 tokens. Restaurante com o cardápio digital ligado também manda itens, preços e alérgenos | +US$ 0,00001; o job (Sonnet 5.5 pelo Batch, 50% mais barato) ~US$ 0,07 por restaurante por semana | +US$ 1 a 2 | O maior ganho: ataca a falta de dado, que é quase metade dos casos | M |
| F | **Lições a partir da avaliação:** avaliar também uma amostra das conversas só da IA e, nas notas baixas com culpa do atendimento, sugerir uma regra curta para a lista da plataforma (revisada por nós, não pelo dono: os erros são quase todos gerais) | ~US$ 0,07 por semana | +US$ 0,30 | Médio; fecha o ciclo de aprendizado | M |
| G | **Esforço `medium` no Haiku** (só um parâmetro), testado no conjunto A | ~US$ 0,0006 com cache | ~US$ 1,50 | Provável melhora em inventar e em seguir regras; medir antes | P |
| H | **Revisão antes de enviar:** segunda chamada do Haiku confere a resposta contra 10 regras críticas | +US$ 0,0003 e +1 a 2 s | +US$ 0,75 | Médio; C pega o mesmo de graça na maioria dos casos | P |
| I | **Sonnet 5.5 só nos casos difíceis** (~15%: reclamação, cancelamento, pagamento, mudança no pedido) | ~US$ 0,003 em média | ~US$ 7 | Baixo: nesses casos a IA só passa para a equipe, e o erro está em decidir o caso, não em escrever | P |
| J | Sonnet 5.5 em tudo | US$ 0,0075 com cache, US$ 0,017 sem | US$ 19 a 43 | Alto em seguir regras, nada em falta de dado | P |
| K | Opus 5.5 em tudo | US$ 0,015 com cache, US$ 0,034 sem | US$ 38 a 85 | Como J, um pouco mais | P |

Notas:
- O cache vale por 5 minutos e é por prefixo. Com o bloco de regras igual para todos os restaurantes, um único cache serve à plataforma inteira nos horários de movimento. Hoje, com o nome do restaurante na primeira linha, isso não é possível.
- O cache é por modelo: em I, o Sonnet quase nunca acharia o cache, por isso a conta é sem ele.
- Pelo restaurante (~30 respostas por dia), J custaria US$ 7 a 15 por mês contra o plano de R$ 149. Cabe, mas não resolve a falta de dado.
- O Haiku 5.5 não tem fallback do servidor quando recusa: a recusa continua caindo no menu, como hoje.

## 4. Recomendação

**Primeiro (uma semana): A + B + C.** O conjunto de teste diz se cada mudança melhora. O cache deixa o prompt crescer sem custo. As travas cortam já os erros mais graves (inventar, "não achei o pedido", alergia). Custo extra: perto de zero; a conta mensal cai.

**Depois: D + E**, medidos no conjunto A. D resolve os conflitos de regra e mostra o estilo com exemplos. E é a resposta direta ao "aprender com as conversas": a IA aprende o que a equipe de cada casa responde, com a aprovação do dono, sem crescer o prompt de todos.

**Em seguida: G e F.** Testar o esforço `medium` antes de pensar em outro modelo. Ligar a avaliação nas conversas só da IA, para o aprendizado ver os erros dela.

**Só se o conjunto A mostrar que o Haiku chegou no limite: J**, com cache. I e H ficam por último: custam mais e ganham pouco aqui.

**Fora do escopo, mas visto na análise:** a `AI_BASE_URL` ainda aponta para o túnel desligado e cada resposta perde ~0,5 s antes de ir para o Claude (o código exige uma principal); e o entregador com a tag Entregador que recebeu resposta da IA em 23/11 precisa ser conferido.
