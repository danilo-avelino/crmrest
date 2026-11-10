import type { ConversationListItem } from "@dishdesk/shared";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

type ChannelType = ConversationListItem["channel"]["type"];

// Pares fundo/texto dos avatares, na ordem do design.
const AVATAR_COLORS = [
  "bg-[#E8D5B7] text-[#8C6A3A]",
  "bg-[#D5E8D4] text-[#2D5A2C]",
  "bg-[#D5E0F0] text-[#2A3A6A]",
  "bg-[#F0E8D5] text-[#7A6030]",
  "bg-[#E8DFF0] text-[#5A3A8C]",
];

export const CHANNEL_DOT: Record<ChannelType, string> = {
  WHATSAPP: "bg-whatsapp",
  INSTAGRAM: "bg-instagram",
  IFOOD: "bg-ifood",
  MESSENGER: "bg-ink-3",
  WEBCHAT: "bg-ink-3",
  CARDAPIO_WEB: "bg-cardapio-web",
};

// Logo do canal no lugar das iniciais (lista de conversas); recorte quadrado e centralizado.
const CHANNEL_LOGO: Partial<Record<ChannelType, string>> = {
  WHATSAPP: "/canais/whatsapp.webp",
  INSTAGRAM: "/canais/instagram.webp",
  IFOOD: "/canais/ifood.webp",
  CARDAPIO_WEB: "/canais/cardapio-web.webp",
};

function colorFor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

/**
 * Avatar com iniciais. Com `channel` (lista de conversas), mostra o logo do canal redondo;
 * canal sem logo fica com as iniciais e a bolinha do canal no canto.
 */
export function Avatar({
  seed,
  name,
  className,
  channel,
  ringClassName,
}: {
  seed: string;
  name: string | null;
  className?: string;
  channel?: ChannelType;
  ringClassName?: string;
}) {
  const logo = channel && CHANNEL_LOGO[channel];
  if (logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- ícone estático de 96px, sem ganho com next/image
      <img src={logo} alt={channel} className={cn("shrink-0 rounded-full object-cover", className)} />
    );
  }
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full font-semibold",
        colorFor(seed),
        className,
      )}
    >
      {initials(name)}
      {channel && (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2.5 rounded-full border-[1.5px] border-surface",
            CHANNEL_DOT[channel],
            ringClassName,
          )}
        />
      )}
    </div>
  );
}

export function ChannelDot({ type, className }: { type: ChannelType; className?: string }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", CHANNEL_DOT[type], className)} />;
}

const BADGE = {
  pending: "border-warning-line bg-warning-lt text-warning-ink",
  resolved: "border-success-line bg-success-lt text-success-ink",
  open: "border-tomate-line bg-tomate-lt text-tomate-ink",
  neutral: "border-rule bg-surface-2 text-ink-2",
} as const;

/** Conversa aberta pelo alerta de fraude: o cliente não está nela. */
export function TeamOnlyBadge() {
  return (
    <span className="shrink-0 rounded-sm border border-rule bg-surface-2 px-[7px] text-[10.5px] leading-[17px] font-medium whitespace-nowrap text-ink-2">Só a equipe</span>
  );
}

/** Selo pequeno de status da lista ("Pendente", "Resolvida", "⚠"). */
export function StatusBadge({
  tone,
  children,
  title,
}: {
  tone: keyof typeof BADGE;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn("inline-flex items-center rounded-[3px] border px-1.5 py-px text-[10px] font-medium", BADGE[tone])}
    >
      {children}
    </span>
  );
}
