---
name: importar-cardapio-ifood
description: Copia o cardápio de uma loja pública do iFood (categorias, itens, preços, tamanhos e fotos) para um restaurante do Dish Desk, pelo Chrome. Use quando o usuário digitar /importar-cardapio-ifood ou pedir para importar/copiar o cardápio do iFood de um restaurante, passando o link da loja e qual restaurante do Dish Desk recebe.
---

# Importar cardápio do iFood (pelo site público)

Solução provisória até a homologação do iFood liberar a Catalog API (`apps/api/src/menu/ifood-catalog.ts`, que é o caminho oficial). Use só com o cardápio do próprio cliente e com a autorização dele. Rode em volume pequeno, uma loja por vez, sem automação recorrente: raspar o site vai contra os termos do iFood.

## Entradas

1. **Link da loja no iFood**, ex.: `https://www.ifood.com.br/delivery/<cidade>/<slug>/<merchantId>`. O `merchantId` é o UUID do fim do link.
2. **Restaurante do Dish Desk** que recebe o cardápio, pelo nome.

Se faltar algum dos dois, pergunte antes de começar.

## Pré-requisitos (conferir com o usuário)

- No Chrome, o Dish Desk aberto e logado, **com o restaurante de destino selecionado**, por uma conta que seja **ADMIN** dele. O superadmin pode usar "entrar como suporte" em `/plataforma`. A API recusa quem não é admin (`adminScope`).
- O módulo **MENU** ligado no restaurante (`requireModule`). Sem ele, o preview devolve erro.

## Passo a passo

Carregue as ferramentas do Chrome numa chamada só (ToolSearch `select:` com `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `javascript_tool`, `read_network_requests`, `get_page_text`). Comece com `tabs_context_mcp`.

### 1. Ler o cardápio no iFood

1. Abra o link da loja numa aba nova.
2. Busque o JSON do cardápio com `javascript_tool`, na própria aba do iFood. O site carrega de:
   `https://marketplace.ifood.com.br/v1/merchants/<merchantId>/catalog`
   Se a resposta não vier ou mudar de forma, use `read_network_requests` (padrão `catalog`) para achar a URL real que a página chamou e repita o `fetch` nela.
3. Formato esperado (confira na 1ª execução e corrija esta skill se mudou): `data.menu[]` = categorias `{ name, itens[] }`; cada item `{ description (nome), details (descrição), unitPrice, unitMinPrice, logoUrl, choices[] }`; cada `choice` `{ name, min, max, garnishItens[] { description, unitPrice } }`.
4. Ainda na aba do iFood, converta para linhas e devolva **só o resumo compacto**, para não estourar a saída:

```js
const SIZE = /^(tamanhos?|escolha o tamanho|size)\b/i;
const cents = (v) => (v == null ? null : Math.round(Number(v) * 100));
const rows = [], photos = [], skipped = new Set();
for (const cat of json.data.menu) {
  for (const it of cat.itens ?? []) {
    const name = it.description.trim();
    const desc = it.details?.trim() || null;
    const size = (it.choices ?? []).find((c) => SIZE.test(c.name.trim()) && (c.max ?? 1) === 1 && c.garnishItens?.length);
    for (const c of it.choices ?? []) if (c !== size) skipped.add(c.name.trim());
    const base = it.unitPrice ?? 0;
    if (size) for (const g of size.garnishItens) rows.push({ category: cat.name.trim(), item: name, description: desc, price: null, size: g.description.trim(), sizePrice: cents(base + (g.unitPrice ?? 0)) });
    else rows.push({ category: cat.name.trim(), item: name, description: desc, price: cents(it.unitPrice || it.unitMinPrice), size: null, sizePrice: null });
    if (it.logoUrl) photos.push({ category: cat.name.trim(), item: name, url: `https://static-images.ifood.com.br/image/upload/t_high/pratos/${it.logoUrl}` });
  }
}
```

A mesma regra do `ifoodCatalogToRows`: grupo "Tamanho" de escolha única vira tamanho do item. Os outros grupos de complementos **não** entram. Liste os nomes deles no aviso final para o usuário cadastrar em Complementos.

Mostre ao usuário: nº de categorias, itens, tamanhos e fotos, e os grupos ignorados. Peça o OK antes de gravar.

### 2. Gravar no Dish Desk

Tudo em `javascript_tool` **na aba do Dish Desk** (mesma origem, `/api`). Não imprima o token na saída.

1. Token e restaurante: `POST /api/auth/refresh` com `credentials: "include"` devolve `{ accessToken, context }`. Confirme que o restaurante do contexto é o pedido pelo usuário e pegue o `tenantId`. Se `accessToken` vier `null` ou o restaurante for outro, pare e peça para o usuário selecionar o restaurante certo.
2. Monte um CSV `;` com cabeçalho `categoria;item;descricao;preco;tamanho;preco_tamanho`, com os preços em `49,90`. Campo com `;`, aspas ou quebra de linha vai entre aspas, com as aspas duplicadas.
3. `POST /api/menu/<tenantId>/import/csv/preview` `{ csv }` com `Authorization: Bearer <token>`. A resposta traz `{ rows, plan, counts }`. Se alguma linha tiver `errors` (item que já existe, preço faltando…), mostre ao usuário e resolva antes, porque o commit é tudo ou nada.
4. `POST /api/menu/<tenantId>/import/csv/commit` `{ rows }`, com as `rows` que o preview devolveu.
5. Fotos: `GET /api/menu/<tenantId>` devolve a árvore do cardápio. Ache o `id` de cada item por categoria + nome. Para cada foto: `fetch(url)` → blob → `PUT /api/menu/<tenantId>/items/<id>/photo` com o blob no corpo e `Content-Type` do blob (jpeg/png/webp, até 1 MB). Faça uma por vez e conte acertos e falhas. Se o iFood mandar uma imagem acima de 1 MB, troque `t_high` por `t_medium` na URL.
   - Se o `fetch` da imagem falhar por CORS, baixe as fotos pela aba do iFood (mesmo domínio de imagens) e passe para a aba do Dish Desk como data URL, uma por vez.

### 3. Fechar

Informe ao usuário quantas categorias, itens, tamanhos e fotos foram importados, quais fotos falharam e quais grupos de complementos ficaram para cadastrar à mão. Feche a aba do iFood que você abriu.

## Quando a homologação sair

Troque esta skill pela importação oficial (`fetchIfoodCatalog` + `ifoodCatalogToRows`).
