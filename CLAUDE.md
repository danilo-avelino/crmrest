# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Commit

**Nunca fazer commit sem pedido explícito do usuário.**

- Não rodar `git commit`, `git push`, criar PR, push de branch ou merge por iniciativa própria — mesmo que pareça o "próximo passo natural" depois de uma mudança. Terminar a tarefa, mostrar o que mudou e esperar o usuário pedir o commit.

---
6. Botões. Em todos os novos botões devemos adicionar um guard de duplo-clique e aviso de Carregando

7. Se forem feitas modificações em uma pagina, sempre lembre de alterar a sua versão mobile (**exceto durante o MVP — Fase 1 do [ROADMAP.md](ROADMAP.md)**, que é só desktop; mobile fica para depois)

## 8. Referências do projeto (consultar SEMPRE)

- **Especificação:** [PROJETO_CRM_RESTAURANTES.md](PROJETO_CRM_RESTAURANTES.md) — visão, stack, arquitetura, modelo de dados, roadmap e convenções.
- **Design:** [CRM Restaurantes.html](CRM Restaurantes.html) — fonte da verdade visual. **Antes de criar ou alterar qualquer tela/componente de UI, consultar este arquivo** e seguir suas cores, tipografia, espaçamentos e componentes. Não inventar estilos fora dele; se algo não existir no design, perguntar.

O HTML é um bundle (≈2,7 MB): o conteúdo fica em `<script type="__bundler/manifest">` (base64 + gzip), com bundles aninhados. Boards: **Sistema de Design**, **Login · Escolha de restaurante**, **Inbox · Conversa ativa · Painel do cliente**, **Módulo Campanhas (extra pago)**. Para ler: decodificar o manifest com Python (`base64` → `gzip.decompress`) e repetir no bundle interno.

Resumo do Sistema de Design (marca **"Comanda"**, Next.js + Tailwind + shadcn/ui):

```css
:root {
  --color-paper: #F7F4EF;  --color-surface: #FFFFFF;  --color-surface-2: #F0EDE8;
  --color-ink: #1A1814;    --color-ink-2: #4A4540;    --color-ink-3: #8C857D;
  --color-rule: #DDD8D0;   --color-accent: #C4341A;   --color-accent-lt: #FDECEA;
  --color-success: #2D7D46; --color-warning: #B45309;
  --font-display: 'Fraunces', Georgia, serif;     /* títulos */
  --font-ui: 'Inter', system-ui, sans-serif;      /* interface e corpo */
  --radius: 6px; --radius-sm: 4px; --radius-lg: 8px;
}
```

- **Tipografia:** Display Fraunces 700/28px (−0.5px); título UI Fraunces 600/16px; label Inter 500/13px; body Inter 400/13px lh 1.5; números sempre `tabular-nums`.
- **Botões (36px, radius 6px, Inter 500/13px):** primário ink (`#1A1814` / texto paper), secundário branco com borda rule, destrutivo/ação tomate (`#C4341A`), ghost transparente; desabilitado com opacity 0.55.
- **Badges de status:** Aberta (tomate), Pendente (âmbar `#FEF9EC`/`#7A5008`), Resolvida (verde `#EAF6EF`/`#1D5C33`); tags com borda tracejada `#C4B8A0`.
- **Cores de canal só como indicador pontual (bolinha):** WhatsApp `#25D366`, Instagram `#E1306C`, iFood `#EA1D2C`.
- **Balões:** entrada branco com borda rule (radius `12 12 12 2`); saída ink com texto paper (radius `12 12 2 12`); automação/nota interna centralizadas em âmbar (nota com borda tracejada).
- **Inputs:** 36px, borda rule; foco borda ink + `box-shadow 0 0 0 3px rgba(26,24,20,.08)`; erro borda e mensagem em tomate.

**No código** (tokens em [apps/web/app/globals.css](apps/web/app/globals.css)):
- Cores: `paper`, `surface`, `surface-2`, `ink`, `ink-2`, `ink-3`, `rule`, `tomate`, `tomate-lt`, `success`, `warning` (ex.: `bg-paper`, `text-ink-3`, `border-rule`). O accent do design chama-se **`tomate`**: no shadcn, `accent` é o fundo de hover.
- Fontes: `font-sans` = Inter (padrão), `font-heading` = Fraunces. Tamanhos: `text-display` (28px), `text-title` (16px), `text-body` (13px, padrão do body).
- Raios: `rounded-sm` 4px, `rounded-md` 5px, `rounded-lg` 6px (padrão dos componentes), `rounded-xl` 8px, `rounded-2xl` 12px.
- Botões: sempre [components/ui/button.tsx](apps/web/components/ui/button.tsx) — variantes `default` (ink), `accent` (tomate), `outline` (secundário), `ghost`, `destructive`; tamanhos `xs` 26px, `sm` 30px, `default` 36px, `lg` 42px. Um `onClick` que retorna Promise já aplica o guard de duplo clique e o "Carregando…" (regra 6); em formulários, passar `loading`.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.