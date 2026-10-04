// Formatos do design: "14 min", "19:07", "Hoje, 19:07", "Sex, 19:07", "R$ 67,40".

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const clockFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
const dateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const currencyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function clock(iso: string): string {
  return clockFormat.format(new Date(iso));
}

/** "Sex, 19:07" */
export function weekdayClock(iso: string): string {
  const weekday = weekdayFormat.format(new Date(iso)).replace(".", "");
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${clock(iso)}`;
}

/** Tempo desde o evento, curto: "agora", "14 min", "2h", "3d". */
export function ago(iso: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (elapsed < MINUTE) return "agora";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

/** "Hoje, 19:07", "Ontem, 19:07", "3 dias atrás" ou "12/09". */
export function dayLabel(iso: string, now: number): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date.getTime())) / DAY);
  if (days === 0) return `Hoje, ${clock(iso)}`;
  if (days === 1) return `Ontem, ${clock(iso)}`;
  if (days < 30) return `${days} dias atrás`;
  return dateFormat.format(date);
}

/** Tempo restante: "18h" ou "45 min". */
export function remaining(iso: string, now: number): string {
  const left = new Date(iso).getTime() - now;
  if (left >= HOUR) return `${Math.floor(left / HOUR)}h`;
  return `${Math.max(1, Math.floor(left / MINUTE))} min`;
}

/** Há quanto tempo é cliente: "9m", "2a" ou "<1m". */
export function tenure(iso: string, now: number): string {
  const months = Math.floor((now - new Date(iso).getTime()) / (30 * DAY));
  if (months < 1) return "<1m";
  return months < 12 ? `${months}m` : `${Math.floor(months / 12)}a`;
}

export function currency(value: string | number): string {
  return currencyFormat.format(Number(value));
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Iniciais para avatares: "Maria Oliveira" → "MO". */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "?").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0]?.slice(0, 2) ?? "?")).toUpperCase();
}
