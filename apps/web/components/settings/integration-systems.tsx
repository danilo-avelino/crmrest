import type { IntegrationDto, IntegrationType } from "@dishdesk/shared";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Field = { name: string; label: string; placeholder?: string; secret?: boolean; numeric?: boolean };

export const GROUPS = ["Canais de atendimento", "Marketplaces"] as const;

/**
 * Cada sistema: o que a integração faz, como identificar a conta e, quando a conexão é por formulário, o que pedir.
 * O Instagram conecta pelo login do Instagram; o WhatsApp, pelo QR Code; o iFood, pelo código de vinculação (os campos
 * dele vêm depois do código).
 */
export const SYSTEMS: {
  type: IntegrationType;
  group: (typeof GROUPS)[number];
  /** Título do modal, quando não é só o nome do sistema. */
  title?: string;
  /** Linha de apoio no painel "Adicionar integração". */
  summary: string;
  description: string;
  /** Rótulos de uma conta: o nome dela e o identificador no sistema de origem. */
  account: string;
  idLabel: string;
  another: string;
  tip?: string;
  help?: string;
  fields?: Field[];
}[] = [
  {
    type: "WHATSAPP",
    group: "Canais de atendimento",
    summary: "Conexão por QR Code",
    description: "Números do WhatsApp ou do WhatsApp Business, conectados pelo QR Code como no WhatsApp Web. As conversas de cada número chegam na Inbox.",
    account: "Número conectado",
    idLabel: "ID no WhatsApp",
    another: "Adicionar outro número",
  },
  {
    type: "INSTAGRAM",
    group: "Canais de atendimento",
    summary: "Mensagens diretas (DMs)",
    description: "Contas profissionais do Instagram. As DMs chegam na Inbox.",
    account: "Conta conectada",
    idLabel: "ID da conta",
    another: "Adicionar outra conta",
  },
  {
    type: "IFOOD",
    group: "Marketplaces",
    summary: "Pedidos",
    description: "Lojas do iFood. Os pedidos entram no cadastro do cliente.",
    account: "Loja conectada",
    idLabel: "ID da loja",
    another: "Adicionar outra loja",
    fields: [{ name: "name", label: "Nome (opcional)", placeholder: "Ex.: Loja Centro" }],
  },
  {
    type: "CARDAPIO_WEB",
    group: "Marketplaces",
    summary: "Pedidos e base de clientes",
    description: "Lojas do Cardápio Web. Ao conectar, a base de clientes da loja é importada; os pedidos entram no cadastro do cliente, achado pelo telefone.",
    account: "Loja conectada",
    idLabel: "Código da loja",
    another: "Adicionar outra loja",
    help: "A chave fica no Portal do Cardápio Web, em Configurações → Integrações → API. Ela é testada antes de salvar.",
    fields: [
      { name: "storeId", label: "Código da loja", placeholder: "Ex.: 13047", numeric: true },
      { name: "apiKey", label: "Chave de API", secret: true },
      { name: "name", label: "Nome (opcional)", placeholder: "Ex.: Loja Centro" },
    ],
  },
  {
    type: "NEEMO",
    group: "Marketplaces",
    summary: "Pedidos e base de clientes",
    description: "Lojas da Neemo (cardápio digital da Linx). Ao conectar, a base de clientes da loja é importada; os pedidos entram no cadastro do cliente, achado pelo telefone.",
    account: "Loja conectada",
    idLabel: "Código da loja",
    another: "Adicionar outra loja",
    help: "O token é gerado pela Neemo para a loja, no painel da Neemo (Configurações → Integração) ou pelo suporte dela. Ele é testado antes de salvar.",
    fields: [
      { name: "apiKey", label: "Token da loja", secret: true },
      { name: "name", label: "Nome (opcional)", placeholder: "Ex.: Loja Centro" },
    ],
  },
];

export type System = (typeof SYSTEMS)[number];

export function systemOf(type: IntegrationType): System {
  return SYSTEMS.find((system) => system.type === type)!;
}

export type Badge = { label: string; className: string; dot: string };

export const STATUS: Record<IntegrationDto["status"], Badge> = {
  CONNECTED: { label: "Conectado", className: "bg-success-lt text-success-ink", dot: "bg-success" },
  ERROR: { label: "Com erro", className: "bg-tomate-lt text-tomate-ink", dot: "bg-tomate" },
  DISCONNECTED: { label: "Desconectado", className: "bg-surface-2 text-ink-3", dot: "bg-ink-3" },
};

/** Ícone do sistema: quadrado na cor do canal com o símbolo em branco. */
const ICONS: Record<IntegrationType, { tile: string; glyph: ReactNode }> = {
  WHATSAPP: {
    tile: "bg-whatsapp",
    glyph: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-[54%]">
        <path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.08-1.35C8.46 21.52 10.2 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm5.26 14.52c-.22.62-1.29 1.18-1.77 1.22-.46.04-.88.2-2.98-.62-2.52-1-4.12-3.57-4.24-3.73-.12-.16-1-1.33-1-2.53 0-1.2.63-1.79.85-2.03.22-.24.48-.3.64-.3h.46c.15 0 .35-.06.55.42.2.5.68 1.66.74 1.78.06.12.1.26.02.42-.08.16-.12.26-.24.4-.12.14-.25.31-.36.42-.12.12-.24.24-.1.47.14.23.62 1.02 1.33 1.65.91.81 1.68 1.06 1.91 1.18.23.12.36.1.49-.06.13-.16.56-.65.71-.87.15-.22.3-.18.5-.11.2.07 1.27.6 1.49.71.22.11.36.16.42.25.05.09.05.53-.17 1.14z" />
      </svg>
    ),
  },
  INSTAGRAM: {
    tile: "bg-[linear-gradient(135deg,#f09433_0%,#e6683c_25%,#dc2743_50%,#cc2366_75%,#bc1888_100%)]",
    glyph: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-[48%]">
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
      </svg>
    ),
  },
  IFOOD: { tile: "bg-ifood", glyph: <span className="font-heading font-bold">iF</span> },
  CARDAPIO_WEB: {
    tile: "bg-cardapio-web",
    glyph: (
      <svg viewBox="0 0 20 16" fill="none" stroke="currentColor" strokeLinecap="round" className="w-[48%]">
        <rect x="1" y="1" width="18" height="14" rx="2" strokeWidth="1.4" />
        <path d="M5 6h10M5 9.5h7" strokeWidth="1.3" />
      </svg>
    ),
  },
  // Degradê do logo da Neemo, com o "n" minúsculo da marca.
  NEEMO: { tile: "bg-[linear-gradient(135deg,#ff4f08_0%,#ffac00_100%)]", glyph: <span className="font-heading font-bold">n</span> },
};

export function SystemIcon({ type, className }: { type: IntegrationType; className: string }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center text-white", ICONS[type].tile, className)}>
      {ICONS[type].glyph}
    </span>
  );
}


export function StatusBadge({ badge, className }: { badge: Badge; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-[5px] rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.02em]", badge.className, className)}>
      <span className={cn("size-[5px] rounded-full", badge.dot)} aria-hidden />
      {badge.label}
    </span>
  );
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Fechar" className="ml-auto rounded-xl bg-paper text-ink-3" onClick={onClick}>
      <XIcon aria-hidden />
    </Button>
  );
}
