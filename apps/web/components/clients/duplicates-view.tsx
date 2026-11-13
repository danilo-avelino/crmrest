"use client";

import { CHANNEL_LABEL, type DuplicatePair, type DuplicateReason, type DuplicateSide, formatPhone } from "@dishdesk/shared";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronLeftIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ChannelDots, ClientAvatar, lastListHref, useDuplicates, useIsAdmin } from "@/components/clients/bits";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { count, lastContact, monthYear } from "@/lib/format";
import { cn } from "@/lib/utils";

const REASON_LABEL: Record<DuplicateReason, string> = {
  phone: "mesmo telefone",
  cpf: "mesmo CPF",
  email: "mesmo e-mail",
  name: "mesmo nome",
  address: "mesmo endereço",
};

const pairKey = (pair: DuplicatePair) => `${pair.keep.id},${pair.other.id}`;
const nameOf = (side: DuplicateSide) => side.name ?? "Cliente sem nome";
const reasonsText = (pair: DuplicatePair) => pair.reasons.map((reason) => REASON_LABEL[reason]).join(" + ");

/** O que a chance do Jev quer dizer. Abaixo de 30% o par nem chega aqui. */
function verdictOf(chance: number): string {
  if (chance >= 0.7) return "Provavelmente é a mesma pessoa";
  if (chance >= 0.5) return "Pode ser a mesma pessoa";
  return "Provavelmente são pessoas diferentes";
}

/** Possíveis duplicados (board Clientes, só admin): fila à esquerda, comparação campo a campo à direita. */
export function DuplicatesView() {
  const admin = useIsAdmin();
  const duplicates = useDuplicates();
  // ?par=<id>,<id> abre direto a comparação (link "Comparar" do detalhe do cliente).
  const linked = useSearchParams().get("par");
  const [selected, setSelected] = useState<string | null>(linked);
  const pairs = duplicates.data ?? [];
  const current = pairs.find((pair) => pairKey(pair) === selected) ?? pairs[0];
  const reviewedByJev = pairs.some((pair) => pair.sameChance !== null);

  // Depois de unir ou descartar, abre o próximo par da fila.
  const next = () => {
    const index = current ? pairs.indexOf(current) : -1;
    const following = pairs[index + 1] ?? pairs[index - 1];
    setSelected(following ? pairKey(following) : null);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <header className="flex shrink-0 items-center justify-between border-b border-rule-soft bg-surface px-7 py-[18px]">
        <div>
          <Link href={lastListHref()} className="mb-1.5 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink-2">
            <ChevronLeftIcon className="size-3" aria-hidden />
            Clientes
          </Link>
          <h1 className="font-heading text-lg font-bold tracking-[-0.3px]">Possíveis duplicados</h1>
          {reviewedByJev && (
            <p className="mt-0.5 text-xs text-ink-3">
              O Jev já revisou estes pares: uniu os que tinha certeza e tirou os de pessoas diferentes. Aqui ficam só os que
              precisam de você.
            </p>
          )}
        </div>
        {pairs.length > 0 && (
          <span className="rounded-md border border-warning-line bg-warning-lt px-3 py-[5px] text-xs font-medium text-warning-ink tabular-nums">
            {pairs.length === 1 ? "1 par para revisar" : `${count(pairs.length)} pares para revisar`}
          </span>
        )}
      </header>

      {!admin ? (
        <Message>Só administradores do restaurante revisam possíveis duplicados.</Message>
      ) : duplicates.isPending ? (
        <Message>
          <LoaderCircleIcon className="size-4 animate-spin" aria-label="Carregando…" />
        </Message>
      ) : duplicates.isError ? (
        <Message>
          Não foi possível carregar os possíveis duplicados.
          <Button variant="outline" size="sm" onClick={() => duplicates.refetch()}>
            Tentar novamente
          </Button>
        </Message>
      ) : !current ? (
        <Message>
          <span className="font-heading text-title font-semibold text-ink">Nenhum possível duplicado</span>
          Quando dois cadastros parecerem da mesma pessoa e o Jev ficar em dúvida, eles aparecem aqui.
        </Message>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <nav aria-label="Pares para revisar" className="w-80 shrink-0 overflow-y-auto border-r border-rule-soft bg-surface">
            {pairs.map((pair) => (
              <QueueItem key={pairKey(pair)} pair={pair} active={pair === current} onSelect={() => setSelected(pairKey(pair))} />
            ))}
          </nav>
          <Comparison key={pairKey(current)} pair={current} onDone={next} />
        </div>
      )}
    </main>
  );
}

function QueueItem({ pair, active, onSelect }: { pair: DuplicatePair; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        "flex w-full items-center gap-3 border-b border-l-[3px] px-[15px] py-3 text-left",
        active ? "border-b-tomate-line border-l-tomate bg-tomate-lt" : "border-b-surface-2 border-l-transparent hover:bg-paper",
      )}
    >
      <div className="flex shrink-0">
        <ClientAvatar seed={pair.keep.id} name={pair.keep.name} className="size-7 text-[10px] ring-2 ring-surface" />
        <ClientAvatar seed={pair.other.id} name={pair.other.name} className="-ml-1 size-7 text-[10px] ring-2 ring-surface" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{nameOf(pair.keep)}</div>
        <div className="truncate text-[12.5px] text-ink-2">{nameOf(pair.other)}</div>
        <div className="mt-1 truncate text-[11px] text-ink-3">{reasonsText(pair)}</div>
      </div>
      {pair.sameChance !== null && (
        <span title="Chance de ser a mesma pessoa, segundo o Jev" className="shrink-0 text-[11px] font-medium text-jev-ink tabular-nums">
          {Math.round(pair.sameChance * 100)}%
        </span>
      )}
    </button>
  );
}

function Comparison({ pair, onDone }: { pair: DuplicatePair; onDone: () => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { keep, other, reasons } = pair;
  const ids = [keep.id, other.id];
  const [now] = useState(() => Date.now());

  const refresh = () => {
    for (const key of ["contact-duplicates", "contacts", "contact", "contact-conversations", "contact-orders", "conversations"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  const merge = async () => {
    setError(null);
    try {
      await request("/contacts/merge", { method: "POST", body: { contactIds: ids } });
      toast("Cadastros unidos com sucesso");
      onDone();
      refresh();
    } catch (failure) {
      // Telefone ou CPF mudou depois de entrar na fila: são pessoas diferentes.
      if (failure instanceof ApiError && failure.status === 409) setBlocked(failure.message);
      else setError(failure instanceof ApiError ? failure.message : "Não foi possível unir os cadastros.");
      setConfirming(false);
    }
  };
  const dismiss = async () => {
    setError(null);
    try {
      await request("/contacts/duplicates/dismiss", { method: "POST", body: { contactIds: ids } });
      toast("Par removido da fila");
      onDone();
      refresh();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível tirar o par da fila.");
    }
  };

  // O que o cadastro que sai leva para o que fica.
  const copies = (field: "phone" | "email" | "cpfMasked") => !keep[field] && Boolean(other[field]);
  const goes = (amount: number, feminine = false) =>
    amount === 0 ? undefined : `${amount === 1 ? "será copiad" : "serão copiad"}${feminine ? "a" : "o"}${amount === 1 ? "" : "s"}`;
  const newAddresses = other.addressKeys.filter((key) => !keep.addressKeys.includes(key)).length;
  const moved = [
    other.channels.length > 0 &&
      `${plural(other.channels.length, "canal", "canais")} (${other.channels.map((channel) => CHANNEL_LABEL[channel]).join(", ")})`,
    other.conversationsCount > 0 && plural(other.conversationsCount, "conversa", "conversas"),
    other.ordersCount > 0 && plural(other.ordersCount, "pedido", "pedidos"),
    newAddresses > 0 && plural(newAddresses, "endereço", "endereços"),
    copies("phone") && "o telefone",
    copies("email") && "o e-mail",
    copies("cpfMasked") && "o CPF",
  ].filter(Boolean);

  const text = (value: string | null, empty = "não informado") =>
    value ? <span className="break-words">{value}</span> : <span className="text-ink-3 italic">{empty}</span>;
  const channels = (side: DuplicateSide) =>
    side.channels.length ? (
      <span className="flex items-center gap-2">
        <ChannelDots channels={side.channels} />
        {side.channels.map((channel) => CHANNEL_LABEL[channel]).join(", ")}
      </span>
    ) : (
      text(null, "nenhum")
    );
  const addresses = (side: DuplicateSide) =>
    side.addresses.length ? (
      <ul className="flex flex-col gap-1">
        {side.addresses.map((address) => (
          <li key={address.text} className={cn("leading-normal", address.matches && "font-medium text-success-ink")}>
            {address.matches && <CheckIcon className="mr-1 inline size-3 align-[-1px]" aria-label="Igual ao do outro cadastro" />}
            {address.text}
          </li>
        ))}
      </ul>
    ) : (
      text(null, "nenhum")
    );

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
        <Verdict pair={pair} />

        <div className="overflow-hidden rounded-xl border border-rule bg-surface">
          <div className="grid grid-cols-[150px_1fr_1fr] border-b border-rule-soft">
            <div />
            <SideHead side={keep} keep />
            <SideHead side={other} />
          </div>
          <FieldRow label="Nome" match={reasons.includes("name")} keep={text(keep.name, "sem nome")} other={text(other.name, "sem nome")} />
          <FieldRow
            label="Telefone"
            match={reasons.includes("phone")}
            keep={text(keep.phone && formatPhone(keep.phone))}
            other={text(other.phone && formatPhone(other.phone))}
            copies={goes(Number(copies("phone")))}
          />
          <FieldRow
            label="E-mail"
            match={reasons.includes("email")}
            keep={text(keep.email)}
            other={text(other.email)}
            copies={goes(Number(copies("email")))}
          />
          <FieldRow
            label="CPF"
            match={reasons.includes("cpf")}
            keep={<span className="tabular-nums">{text(keep.cpfMasked)}</span>}
            other={<span className="tabular-nums">{text(other.cpfMasked)}</span>}
            copies={goes(Number(copies("cpfMasked")))}
          />
          <FieldRow
            label="Endereços"
            match={reasons.includes("address")}
            keep={addresses(keep)}
            other={addresses(other)}
            copies={goes(newAddresses)}
          />
          <FieldRow label="Canais" keep={channels(keep)} other={channels(other)} copies={goes(other.channels.length)} />
          <FieldRow
            label="Pedidos"
            keep={<span className="tabular-nums">{keep.ordersCount}</span>}
            other={<span className="tabular-nums">{other.ordersCount}</span>}
            copies={goes(other.ordersCount)}
          />
          <FieldRow
            label="Conversas"
            keep={<span className="tabular-nums">{keep.conversationsCount}</span>}
            other={<span className="tabular-nums">{other.conversationsCount}</span>}
            copies={goes(other.conversationsCount, true)}
          />
          <FieldRow label="Cliente desde" keep={monthYear(keep.firstSeenAt)} other={monthYear(other.firstSeenAt)} />
          <FieldRow
            label="Último contato"
            keep={text(keep.lastSeenAt && lastContact(keep.lastSeenAt, now), "nunca")}
            other={text(other.lastSeenAt && lastContact(other.lastSeenAt, now), "nunca")}
          />
        </div>
      </div>

      <footer className="shrink-0 border-t border-rule-soft bg-surface px-7 py-4">
        {error && <p className="mb-2 text-[12px] text-tomate">{error}</p>}
        {blocked ? (
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-rule bg-surface-2">
              <LockIcon className="size-4 text-ink-3" aria-hidden />
            </div>
            <div className="flex-1">
              <div className="text-[13px] font-medium">{blocked}</div>
              <div className="text-xs text-ink-3">São pessoas diferentes e os cadastros não podem ser unidos.</div>
            </div>
            {/* Com telefones ou CPFs diferentes o par já sai da fila: é só seguir. */}
            <Button
              variant="outline"
              onClick={() => {
                onDone();
                refresh();
              }}
            >
              Próximo par
            </Button>
          </div>
        ) : confirming ? (
          <div className="theme-light flex items-center gap-4 rounded-xl bg-ink px-5 py-4">
            <div className="flex-1">
              <div className="mb-1 font-heading text-[15px] font-bold text-paper">Unir cadastros?</div>
              <p className="text-[12.5px] leading-normal text-ink-3">
                Esta ação é irreversível. O cadastro mais novo ({nameOf(other)}) será removido, e os dados dele vão para o mais
                antigo ({nameOf(keep)}).
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="accent" onClick={merge}>
                Confirmar e unir
              </Button>
              <Button
                variant="ghost"
                className="border-[#3D3A34] text-ink-3 hover:bg-[#2D2A24] hover:text-paper"
                onClick={() => setConfirming(false)}
              >
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-6">
            <p className="min-w-0 flex-1 text-[12.5px] leading-normal text-ink-2">
              <span className="font-medium text-ink">Se unir:</span> fica o cadastro de {nameOf(keep)}, o mais antigo.{" "}
              {moved.length > 0 ? `Vão para ele ${moved.join(", ")}.` : "Nada mais muda nele."} Endereços repetidos não se
              duplicam e as tags são recalculadas.
            </p>
            <div className="flex shrink-0 gap-2.5">
              <Button variant="outline" onClick={dismiss}>
                Não são a mesma pessoa
              </Button>
              <Button onClick={() => setConfirming(true)}>Unir cadastros</Button>
            </div>
          </div>
        )}
      </footer>
    </section>
  );
}

/** O que o Jev achou do par; sem o Jev, só por que o par apareceu. */
function Verdict({ pair }: { pair: DuplicatePair }) {
  const reasons = `Apareceram por ${reasonsText(pair)}. Os dados iguais estão destacados abaixo.`;
  if (pair.sameChance === null) {
    return <div className="rounded-xl border border-rule bg-surface px-[18px] py-3.5 text-[12.5px] text-ink-2">{reasons}</div>;
  }
  const percent = Math.round(pair.sameChance * 100);
  return (
    <div className="flex items-center gap-6 rounded-xl border border-rule bg-surface px-[18px] py-4">
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[10.5px] font-medium tracking-[0.07em] text-jev-ink uppercase">Análise do Jev</div>
        <div className="font-heading text-title font-semibold">{verdictOf(pair.sameChance)}</div>
        <p className="mt-0.5 text-[12.5px] text-ink-2">{reasons}</p>
      </div>
      <div className="w-36 shrink-0">
        <div className="mb-1.5 flex items-baseline justify-end gap-1">
          <span className="font-heading text-[26px] leading-none font-bold text-jev-ink tabular-nums">{percent}%</span>
        </div>
        <div
          role="img"
          aria-label={`${percent}% de chance de ser a mesma pessoa`}
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full rounded-full bg-jev" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-1 text-right text-[11px] text-ink-3">de ser a mesma pessoa</div>
      </div>
    </div>
  );
}

function SideHead({ side, keep = false }: { side: DuplicateSide; keep?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5 border-l border-rule-soft px-4 py-3.5", keep && "bg-success-lt")}>
      <ClientAvatar seed={side.id} name={side.name} className="size-9 text-[13px]" />
      <div className="min-w-0">
        <Link href={`/clientes/${side.id}`} className="block truncate font-heading text-[15px] font-bold hover:underline">
          {nameOf(side)}
        </Link>
        {keep ? (
          <div className="text-[11px] font-medium text-success-ink">✓ Fica: cadastro mais antigo</div>
        ) : (
          <div className="text-[11px] text-ink-3">Sai: os dados vão para o outro</div>
        )}
      </div>
    </div>
  );
}

/** Uma linha da comparação. `match`: o dado que fez o par aparecer (igual nos dois). `copies`: o que vai para o que fica. */
function FieldRow({ label, keep, other, match = false, copies }: { label: string; keep: ReactNode; other: ReactNode; match?: boolean; copies?: string }) {
  return (
    <div className={cn("grid grid-cols-[150px_1fr_1fr] border-b border-surface-2 text-[12.5px] last:border-b-0", match && "bg-success-lt")}>
      <div className="flex flex-col items-start gap-1 px-4 py-2.5">
        <span className="text-[10.5px] font-medium tracking-[0.05em] text-ink-3 uppercase">{label}</span>
        {match && (
          <span className="inline-flex items-center gap-0.5 rounded-[3px] border border-success-line bg-surface px-1.5 text-[10px] font-medium text-success-ink">
            <CheckIcon className="size-2.5" aria-hidden />
            igual
          </span>
        )}
      </div>
      <div className="min-w-0 border-l border-surface-2 px-4 py-2.5">{keep}</div>
      <div className="min-w-0 border-l border-surface-2 px-4 py-2.5">
        {other}
        {copies && <div className="mt-0.5 text-[11px] font-medium text-success">→ {copies}</div>}
      </div>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-ink-3">{children}</div>;
}

function plural(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`;
}
