"use client";

import {
  CHANNEL_LABEL,
  type ContactFilterOptions,
  type ContactListItem,
  type ContactPage,
  type ContactSort,
  formatPhone,
  type LastContactFilter,
} from "@comanda/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, SearchIcon, TriangleAlertIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ChannelDots, ClientAvatar, DuplicateBadge, rememberListHref, useDuplicates } from "@/components/clients/bits";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNow } from "@/hooks/use-now";
import { count, currency, duration, fullDate, lastContact } from "@/lib/format";
import { cn } from "@/lib/utils";

type ChannelType = keyof typeof CHANNEL_LABEL;

const CHANNELS = Object.keys(CHANNEL_LABEL) as ChannelType[];
const LAST_CONTACT_LABEL: Record<LastContactFilter, string> = {
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  over30d: "Sem contato há mais de 30 dias",
  over60d: "Sem contato há mais de 60 dias",
  over90d: "Sem contato há mais de 90 dias",
};
const FILTER_KEYS = ["search", "tag", "channel", "district", "phonePending", "lastContact"];

/** Lista de clientes (board Clientes). Busca, filtros, ordem e página ficam na URL. */
export function ClientList() {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const now = useNow(60_000);

  useEffect(() => rememberListHref(query ? `/clientes?${query}` : "/clientes"), [query]);

  const contacts = useQuery({
    queryKey: ["contacts", query],
    queryFn: () => request<ContactPage>(`/contacts?${query}`),
    placeholderData: keepPreviousData,
  });
  const options = useQuery({
    queryKey: ["contact-filters"],
    queryFn: () => request<ContactFilterOptions>("/contacts/filters"),
  });
  const duplicates = useDuplicates();
  const flagged = new Set(duplicates.data?.flatMap((pair) => [pair.keep.id, pair.other.id]));

  /** Muda parâmetros da URL (lidos dela, não do render, para não perder cliques seguidos); volta para a página 1. */
  const update = (changes: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      for (const item of [value ?? []].flat()) if (item) next.append(key, item);
    }
    if (!("page" in changes)) next.delete("page");
    const target = next.toString();
    router.replace(target ? `/clientes?${target}` : "/clientes", { scroll: false });
  };
  const toggle = (key: string, value: string, on: boolean) => {
    const current = new URLSearchParams(window.location.search).getAll(key).filter((item) => item !== value);
    update({ [key]: on ? [...current, value] : current });
  };
  const onSearch = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => update({ search: value.trim() || null }), 300);
  };
  const clearFilters = () => {
    clearTimeout(searchTimer.current);
    setSearch("");
    update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])));
  };

  const tags = params.getAll("tag");
  const channels = params.getAll("channel") as ChannelType[];
  const district = params.get("district");
  const phonePending = params.get("phonePending") === "true";
  const lastContactFilter = params.get("lastContact") as LastContactFilter | null;
  const filtered = FILTER_KEYS.some((key) => params.has(key));
  const sort = (params.get("sort") ?? "lastSeen") as ContactSort;
  const order = params.get("order") ?? "desc";
  const sortBy = (column: ContactSort) =>
    update({
      sort: column,
      order: sort === column ? (order === "desc" ? "asc" : "desc") : column === "name" || column === "phone" ? "asc" : "desc",
    });

  const data = contacts.data;
  const pairs = duplicates.data?.length ?? 0;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <header className="shrink-0 border-b border-rule-soft px-7 pt-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="mb-[3px] font-heading text-[21px] leading-tight font-bold tracking-[-0.3px]">Clientes</h1>
            <span className="text-xs text-ink-3 tabular-nums">
              {data ? `${count(data.total)} ${data.total === 1 ? "cliente" : "clientes"}` : " "}
            </span>
          </div>
          {pairs > 0 && (
            <div className="flex items-center gap-2 rounded-[7px] border border-[#FDE68A] bg-warning-lt px-3.5 py-2">
              <TriangleAlertIcon className="size-3.5 text-[#D97706]" aria-hidden />
              <span className="text-xs font-medium text-warning-ink">
                {pairs === 1 ? "1 possível duplicado" : `${count(pairs)} possíveis duplicados`}
              </span>
              <Link href="/clientes/duplicados" className="text-xs font-medium text-tomate underline underline-offset-2">
                Revisar
              </Link>
            </div>
          )}
        </div>

        <label className="relative mb-3 block w-[400px] max-w-full">
          <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Buscar por nome, telefone ou CPF"
            aria-label="Buscar cliente por nome, telefone ou CPF"
            className="h-[34px] w-full rounded-lg border border-rule bg-surface pr-3 pl-8 text-[13px] outline-none placeholder:text-ink-3 focus:border-ink focus:ring-3 focus:ring-ink/8"
          />
        </label>

        <div className="flex flex-wrap gap-1.5 pb-3">
          <DropdownMenu>
            <DropdownMenuTrigger className={chipClass(tags.length > 0)}>
              {chipLabel("Tag", tags)}
              <ChevronDownIcon className="size-2.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-72 w-56">
              {options.data?.tags.length ? (
                options.data.tags.map((tag) => (
                  <DropdownMenuCheckboxItem key={tag} checked={tags.includes(tag)} onCheckedChange={(on) => toggle("tag", tag, on)}>
                    {tag}
                  </DropdownMenuCheckboxItem>
                ))
              ) : (
                <p className="px-1.5 py-1 text-xs text-ink-3">Nenhuma tag nos cadastros.</p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger className={chipClass(channels.length > 0)}>
              {chipLabel("Canal", channels, (channel) => CHANNEL_LABEL[channel as ChannelType])}
              <ChevronDownIcon className="size-2.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              {CHANNELS.map((channel) => (
                <DropdownMenuCheckboxItem
                  key={channel}
                  checked={channels.includes(channel)}
                  onCheckedChange={(on) => toggle("channel", channel, on)}
                >
                  <span className={cn("size-2 rounded-full", CHANNEL_DOT[channel])} />
                  {CHANNEL_LABEL[channel]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DistrictFilter districts={options.data?.districts ?? []} value={district} onChange={(value) => update({ district: value })} />

          <button
            type="button"
            aria-pressed={phonePending}
            onClick={() => update({ phonePending: phonePending ? null : "true" })}
            className={chipClass(phonePending)}
          >
            Telefone pendente
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger className={chipClass(Boolean(lastContactFilter))}>
              {lastContactFilter ? LAST_CONTACT_LABEL[lastContactFilter] : "Último contato"}
              <ChevronDownIcon className="size-2.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64">
              <DropdownMenuRadioGroup
                value={lastContactFilter ?? ""}
                onValueChange={(value: string) => update({ lastContact: value || null })}
              >
                <DropdownMenuRadioItem value="">Qualquer data</DropdownMenuRadioItem>
                {(Object.keys(LAST_CONTACT_LABEL) as LastContactFilter[]).map((key) => (
                  <DropdownMenuRadioItem key={key} value={key}>
                    {LAST_CONTACT_LABEL[key]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {filtered && (
            <button
              type="button"
              onClick={clearFilters}
              className="px-1 text-xs text-tomate underline underline-offset-2 hover:text-tomate/80"
            >
              Limpar filtros
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {contacts.isPending ? (
          <TableSkeleton />
        ) : contacts.isError ? (
          <div className="p-7">
            <div className="flex max-w-lg items-start gap-3 rounded-xl border border-tomate-line bg-tomate-lt p-5">
              <AlertCircleIcon className="mt-px size-[18px] shrink-0 text-tomate" aria-hidden />
              <div>
                <div className="mb-1 text-[13px] font-medium">Não foi possível carregar os clientes</div>
                <div className="mb-2.5 text-xs text-ink-3">Verifique sua conexão e tente novamente.</div>
                <Button variant="outline" size="sm" onClick={() => contacts.refetch()}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </div>
        ) : data!.items.length === 0 ? (
          filtered ? (
            <Empty
              icon={<SearchIcon className="size-8 text-ink opacity-30" aria-hidden />}
              title="Nenhum cliente encontrado"
              text="Tente outros termos ou remova os filtros."
            >
              <Button variant="outline" size="sm" className="mt-3.5" onClick={clearFilters}>
                Limpar todos os filtros
              </Button>
            </Empty>
          ) : (
            <Empty
              icon={
                <div className="flex size-12 items-center justify-center rounded-[10px] border border-rule bg-paper">
                  <UserIcon className="size-[22px] text-rule" aria-hidden />
                </div>
              }
              title="Nenhum cliente ainda"
              text="Os clientes aparecem aqui assim que mandarem a primeira mensagem ou fizerem um pedido."
            />
          )
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-paper">
                <Th column="name" sort={sort} order={order} onSort={sortBy}>
                  Cliente
                </Th>
                <Th column="phone" sort={sort} order={order} onSort={sortBy}>
                  Telefone
                </Th>
                <Th>Canais</Th>
                <Th>Bairro</Th>
                <Th column="orders" sort={sort} order={order} onSort={sortBy} align="right">
                  Pedidos
                </Th>
                <Th align="right">Total gasto</Th>
                <Th column="lastSeen" sort={sort} order={order} onSort={sortBy}>
                  Último contato
                </Th>
                <Th>Cliente desde</Th>
              </tr>
            </thead>
            <tbody>
              {data!.items.map((contact) => (
                <ClientRow key={contact.id} contact={contact} duplicate={flagged.has(contact.id)} showTenant={master} now={now} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.total > 0 && (
        <footer className="flex shrink-0 items-center justify-between border-t border-rule-soft px-7 py-3">
          <span className="text-xs text-ink-3 tabular-nums">
            {count((data.page - 1) * data.pageSize + 1)}–{count(Math.min(data.page * data.pageSize, data.total))} de{" "}
            {count(data.total)} {data.total === 1 ? "cliente" : "clientes"}
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={data.page <= 1} onClick={() => update({ page: String(data.page - 1) })}>
              ← Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={data.page * data.pageSize >= data.total}
              onClick={() => update({ page: String(data.page + 1) })}
            >
              Próxima →
            </Button>
          </div>
        </footer>
      )}
    </main>
  );
}

function ClientRow({
  contact,
  duplicate,
  showTenant,
  now,
}: {
  contact: ContactListItem;
  duplicate: boolean;
  showTenant: boolean;
  now: number;
}) {
  const router = useRouter();
  const href = `/clientes/${contact.id}`;
  const anonymized = Boolean(contact.anonymizedAt);

  return (
    <tr
      onClick={() => router.push(href)}
      className={cn("group cursor-pointer", duplicate && "bg-[#FFFDF5]", anonymized && "opacity-60")}
    >
      <Td>
        <div className="flex items-center gap-2.5">
          <ClientAvatar seed={contact.id} name={contact.name} anonymized={anonymized} className="size-[34px] text-[13px]" />
          <div className="min-w-0">
            <div className="mb-[3px] flex items-center gap-1.5">
              <Link
                href={href}
                onClick={(event) => event.stopPropagation()}
                className={cn("text-[13px] hover:underline", anonymized ? "text-ink-3 italic" : "font-medium")}
              >
                {anonymized ? "Cliente anonimizado" : (contact.name ?? "Cliente sem nome")}
              </Link>
              {duplicate && <DuplicateBadge />}
            </div>
            {anonymized ? (
              <div className="text-[11px] text-ink-3 tabular-nums">Anonimizado em {fullDate(contact.anonymizedAt!)}</div>
            ) : (
              contact.tags.length > 0 && (
                <div className="flex gap-1">
                  {contact.tags.slice(0, 2).map((tag) => (
                    <span key={tag} className="rounded-sm border border-dashed border-tag-line px-2 py-px text-[11px] text-ink-2">
                      {tag}
                    </span>
                  ))}
                  {contact.tags.length > 2 && <span className="py-px text-[11px] text-ink-3">+{contact.tags.length - 2}</span>}
                </div>
              )
            )}
            {showTenant && <div className="mt-0.5 text-[10.5px] text-ink-3">{contact.tenant.name}</div>}
          </div>
        </div>
      </Td>
      <Td>
        {contact.phone ? (
          <span className="tabular-nums">{formatPhone(contact.phone)}</span>
        ) : anonymized ? null : contact.phoneStatus === "pending" ? (
          <span className="flex items-center gap-[5px] text-xs font-medium text-warning">
            <TriangleAlertIcon className="size-3 text-[#D97706]" aria-hidden />
            pendente
          </span>
        ) : (
          <span className="text-xs text-ink-3 italic">não informado</span>
        )}
      </Td>
      <Td>
        <ChannelDots channels={contact.channels} />
      </Td>
      <Td className="text-ink-2">{contact.district}</Td>
      <Td className="text-right font-medium tabular-nums">{contact.ordersCount}</Td>
      <Td className="text-right tabular-nums">{currency(contact.ordersTotal)}</Td>
      <Td className="text-ink-3 tabular-nums">{contact.lastSeenAt ? lastContact(contact.lastSeenAt, now) : "—"}</Td>
      <Td className="text-ink-3">{duration(contact.firstSeenAt, now)}</Td>
    </tr>
  );
}

function Th({
  children,
  column,
  sort,
  order,
  onSort,
  align = "left",
}: {
  children: ReactNode;
  column?: ContactSort;
  sort?: ContactSort;
  order?: string;
  onSort?: (column: ContactSort) => void;
  align?: "left" | "right";
}) {
  const active = column !== undefined && column === sort;
  return (
    <th
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "border-b border-rule-soft px-3 py-2.5 text-[11px] font-medium tracking-[0.05em] whitespace-nowrap text-ink-3 uppercase select-none first:pl-7 last:pr-7",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {column ? (
        <button type="button" onClick={() => onSort?.(column)} className="uppercase hover:text-ink-2">
          {children}{" "}
          <span className={active ? "text-tomate" : "text-rule"} aria-hidden>
            {active ? (order === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td
      className={cn(
        "border-b border-surface-2 px-3 py-[13px] align-middle text-[12.5px] group-hover:bg-[#F7F6F4] first:pl-7 last:pr-7",
        className,
      )}
    >
      {children}
    </td>
  );
}

function DistrictFilter({
  districts,
  value,
  onChange,
}: {
  districts: string[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const shown = districts.filter((district) => district.toLowerCase().includes(term.trim().toLowerCase()));
  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
    setTerm("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={chipClass(Boolean(value))}>
        {value ?? "Bairro"}
        <ChevronDownIcon className="size-2.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 gap-1.5 p-1.5">
        <input
          autoFocus
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Buscar bairro"
          aria-label="Buscar bairro"
          className="h-8 rounded-md border border-rule px-2.5 text-xs outline-none focus:border-ink"
        />
        <div className="max-h-60 overflow-y-auto">
          {value && (
            <DistrictOption onClick={() => choose(null)} selected={false}>
              Todos os bairros
            </DistrictOption>
          )}
          {shown.map((district) => (
            <DistrictOption key={district} selected={district === value} onClick={() => choose(district)}>
              {district}
            </DistrictOption>
          ))}
          {shown.length === 0 && <p className="px-1.5 py-1 text-xs text-ink-3">Nenhum bairro encontrado.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DistrictOption({ children, selected, onClick }: { children: ReactNode; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-surface-2"
    >
      {children}
      {selected && <CheckIcon className="size-3.5" aria-hidden />}
    </button>
  );
}

function Empty({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-20 text-center">
      <div className="mb-3.5">{icon}</div>
      <div className="mb-1.5 font-heading text-[15px] font-semibold">{title}</div>
      <p className="max-w-[260px] text-[12.5px] leading-[1.55] text-ink-3">{text}</p>
      {children}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div aria-busy aria-label="Carregando clientes" className="flex flex-col gap-3 px-7 py-5">
      {[55, 45, 60, 40, 50].map((width, index) => (
        <div key={index} className="flex animate-pulse items-center gap-2.5" style={{ opacity: 1 - index * 0.15 }}>
          <div className="size-[34px] shrink-0 rounded-full bg-surface-2" />
          <div className="flex-1">
            <div className="mb-1.5 h-3 rounded-sm bg-surface-2" style={{ width: `${width}%` }} />
            <div className="h-2.5 w-[30%] rounded-sm bg-surface-2" />
          </div>
          <div className="h-2.5 w-20 rounded-sm bg-surface-2" />
          <div className="h-2.5 w-16 rounded-sm bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

function chipClass(active: boolean): string {
  return cn(
    "inline-flex h-[30px] items-center gap-[5px] rounded-md border px-3 text-xs whitespace-nowrap",
    active ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2 hover:bg-paper",
  );
}

/** Rótulo do chip: o nome do filtro, o valor escolhido ou a quantidade ("Canal (2)"). */
function chipLabel(label: string, values: string[], format: (value: string) => string = (value) => value): string {
  if (values.length === 0) return label;
  return values.length === 1 ? format(values[0]!) : `${label} (${values.length})`;
}
