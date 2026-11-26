# Vendedores e parceiros

Anotado em 23/11/2026, a pedido do usuário. A área dos vendedores ainda não existe. Este arquivo guarda o que já foi
decidido e o que falta, para quando ela for feita.

O plano completo da área dos vendedores (CRM de vendas com a IA no primeiro contato) está em
[docs/crm-vendas/ROADMAP.md](crm-vendas/ROADMAP.md), desde 25/11/2026.

## O que o usuário pediu

- Vendedores e parceiros do Dish Desk recebem um **código promocional** próprio.
- O restaurante informa o código no cadastro do teste grátis (`/cadastro`, campo "Código promocional (opcional)").
- Com o código, o teste grátis vai de 15 para **30 dias**.
- Depois do cadastro, a conta fica **ligada ao vendedor** dono do código.

## O que já está feito (23/11/2026)

- Tabela `promo_codes` (model `PromoCode`): `code` (único, sempre em maiúsculas), `seller_name`, `is_active`, `created_at`.
  Migration `20261123120000_promo_codes`.
- `tenants.promo_code_id`: o código usado no cadastro. Fica vazio em quem se cadastrou sem código e nos restaurantes
  criados pela plataforma.
- `app.signup_tenant` confere o código (sem diferenciar maiúsculas e minúsculas, sem espaços nas pontas). Código que não
  existe ou está desativado recusa o cadastro com "Código promocional não encontrado. Confira com quem passou."
  (ninguém é criado). Código válido dá `PROMO_TRIAL_DAYS` (30, em `packages/shared/src/billing.ts`) dias de teste.
- Só a plataforma (super admin) lê e altera `promo_codes` pela aplicação (RLS). Ainda não há tela.
- Teste em `apps/api/test/billing.test.ts` ("código promocional dá 30 dias...").

### Criar um código enquanto não há tela

Direto no banco, com o usuário dono (Supabase, SQL Editor):

```sql
INSERT INTO promo_codes (id, code, seller_name) VALUES (gen_random_uuid(), 'JOAO30', 'João Silva');
-- Desativar (quem já se cadastrou continua ligado ao código):
UPDATE promo_codes SET is_active = false WHERE code = 'JOAO30';
-- Restaurantes trazidos por um código:
SELECT t.name, t.created_at, t.trial_ends_at, t.paid_until
FROM tenants t JOIN promo_codes p ON p.id = t.promo_code_id
WHERE p.code = 'JOAO30' ORDER BY t.created_at DESC;
```

## O que falta para a área dos vendedores

- **Cadastro do vendedor:** tabela `sellers` (nome, contato, tipo: vendedor ou parceiro, ativo). Trocar
  `promo_codes.seller_name` por `seller_id` (copiar os nomes que já existirem para vendedores novos). Um vendedor pode
  ter mais de um código.
- **Tela na plataforma** (`/plataforma`): criar, desativar e listar códigos e vendedores, com quantos restaurantes cada
  um trouxe. A lista de restaurantes da plataforma mostra o vendedor de cada um.
- **Acompanhamento do vendedor:** quantos restaurantes se cadastraram com o código, quantos estão em teste, quantos
  pagaram e quantos foram bloqueados. Decidir se o vendedor tem login próprio para ver isso ou se a plataforma manda o
  relatório.
- **A definir com o usuário:**
  - Comissão: valor ou percentual, só na primeira mensalidade ou recorrente, mensal e anual iguais ou não.
  - Se dá para trocar ou colocar o vendedor depois do cadastro (ex.: restaurante que esqueceu o código).
  - Se o código pode ter validade ou limite de usos.
  - Se o restaurante adicionado por quem já tem conta (sem teste grátis) também pode levar o código.
  - Link pronto do vendedor (ex.: `/cadastro?codigo=JOAO30`) que já preenche o campo, para mandar pelo WhatsApp.
- **Atenção:** a trava de reuso do teste (`app.claim_channel`) continua valendo com o código: canal que já passou por
  outro teste encerra o teste novo, mesmo com 30 dias.
