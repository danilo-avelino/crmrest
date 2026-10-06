// Formatos do design: "14 min", "19:07", "Hoje, 19:07", "Sex, 19:07", "R$ 67,40".

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const clockFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
const dateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const currencyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const integerFormat = new Intl.NumberFormat("pt-BR");
const wholeCurrencyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const fullDateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const monthYearFormat = new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric" });

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

/** Valor sem centavos, para métricas: "R$ 1.240". */
export function currencyWhole(value: string | number): string {
  return wholeCurrencyFormat.format(Number(value));
}

/** "1.284" */
export function count(value: number): string {
  return integerFormat.format(value);
}

/** Último contato (lista de clientes): "há 5 min", "há 2 h", "ontem" ou "12/09". */
export function lastContact(iso: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  const days = daysBetween(iso, now);
  if (days === 0) return elapsed < HOUR ? `há ${Math.max(1, Math.floor(elapsed / MINUTE))} min` : `há ${Math.floor(elapsed / HOUR)} h`;
  return days === 1 ? "ontem" : dateFormat.format(new Date(iso));
}

/** Há quanto tempo, por extenso (cliente desde): "3 dias", "2 semanas", "1 mês", "9 meses", "2 anos". */
export function duration(iso: string, now: number): string {
  const days = Math.max(1, Math.floor((now - new Date(iso).getTime()) / DAY));
  if (days < 7) return plural(days, "dia", "dias");
  if (days < 30) return plural(Math.floor(days / 7), "semana", "semanas");
  if (days < 365) return plural(Math.floor(days / 30), "mês", "meses");
  return plural(Math.floor(days / 365), "ano", "anos");
}

/** "mar/2026" */
export function monthYear(iso: string): string {
  const parts = monthYearFormat.formatToParts(new Date(iso));
  const month = parts.find((part) => part.type === "month")?.value.replace(".", "");
  return `${month}/${parts.find((part) => part.type === "year")?.value}`;
}

/** "04/10/2026" */
export function fullDate(iso: string): string {
  return fullDateFormat.format(new Date(iso));
}

/** Data e hora curtas: "hoje, 17:48", "ontem, 20:14" ou "01/10, 20:14". */
export function dayTime(iso: string, now: number): string {
  const days = daysBetween(iso, now);
  return `${days === 0 ? "hoje" : days === 1 ? "ontem" : dateFormat.format(new Date(iso))}, ${clock(iso)}`;
}

/** Data de uma conversa: com hora se for de hoje ou ontem ("hoje, 18:32"), senão só o dia ("28/09"). */
export function shortDay(iso: string, now: number): string {
  return daysBetween(iso, now) <= 1 ? dayTime(iso, now) : dateFormat.format(new Date(iso));
}

function daysBetween(iso: string, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso).getTime())) / DAY);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Iniciais para avatares: "Maria Oliveira" → "MO". */
export function initials(name: string | null | undefined): string {
  // Só letras e números contam: "Aglio Nero | Pizzeria 🍕" vira "AP", nunca meio emoji ("A�").
  const words = (name ?? "")
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word).filter((char) => /[\p{L}\p{N}]/u.test(char)))
    .filter((letters) => letters.length > 0);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? [words[0]![0], words.at(-1)![0]] : words[0]!.slice(0, 2);
  return letters.join("").toUpperCase();
}

const scoreFormat = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Nota média (1 a 5): "4,3". */
export function score(value: number): string {
  return scoreFormat.format(value);
}

/** Tempo de resposta: "45 s", "12 min", "1h 05 min". */
export function responseTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")} min`;
}
