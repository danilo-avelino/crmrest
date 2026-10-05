"use client";

import { CHANNEL_LABEL, type DuplicatePair, type DuplicateReason, type DuplicateSide, formatPhone } from "@comanda/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeftIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ChannelDots, ClientAvatar, lastListHref, useDuplicates, useIsAdmin } from "@/components/clients/bits";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { count, monthYear } from "@/lib/format";
import { cn } from "@/lib/utils";

const REASON_LABEL: Record<DuplicateReason, string> = {
  phone: "mesmo telefone",
  cpf: "mesmo CPF",
  email: "mesmo e-mail",
  name: "mesmo nome",
  address: "mesmo endereço de entrega",
};

const pairKey = (pair: DuplicatePair) => `${pair.keep.id},${pair.other.id}`;
const nameOf = (side: DuplicateSide) => side.name ?? "Cliente sem nome";

/** Possíveis duplicados (board Clientes, só admin): fila à esquerda, comparação lado a lado à direita. */
export function DuplicatesView() {
  const admin = useIsAdmin();
  const duplicates = useDuplicates();
  // ?par=<id>,<id> abre direto a comparação (link "Comparar" do detalhe do cliente).
  const linked = useSearchParams().get("par");
  const [selected, setSelected] = useState<string | null>(linked);
  const pairs = duplicates.data ?? [];
  const current = pairs.find((pair) => pairKey(pair) === selected) ?? pairs[0];

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <header className="flex shrink-0 items-center justify-between border-b border-rule-soft bg-surface px-7 py-[18px]">
        <div>
          <Link href={lastListHref()} className="mb-1.5 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink-2">
            <ChevronLeftIcon className="size-3" aria-hidden />
            Clientes
          </Link>
          <h1 className="font-heading text-lg font-bold tracking-[-0.3px]">Possíveis duplicados</h1>
        </div>
        {pairs.length > 0 && (
          <span className="rounded-md border border-[#FDE68A] bg-warning-lt px-3 py-[5px] text-xs font-medium text-warning-ink tabular-nums">
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
        <Message>Nenhum possível duplicado.</Message>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <nav aria-label="Pares para revisar" className="w-80 shrink-0 overflow-y-auto border-r border-rule-soft bg-surface">
            {pairs.map((pair) => (
              <QueueItem key={pairKey(pair)} pair={pair} active={pair === current} onSelect={() => setSelected(pairKey(pair))} />
            ))}
          </nav>
          <Comparison key={pairKey(current)} pair={current} onDone={() => setSelected(null)} />
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
        "block w-full border-b px-[18px] py-3.5 text-left",
        active ? "border-b-tomate-line border-l-[3px] border-l-tomate bg-tomate-lt" : "border-b-surface-2 opacity-70 hover:opacity-100",
      )}
    >
      <div className="mb-2 text-[11px] text-ink-3">{pair.reasons.map((reason) => REASON_LABEL[reason]).join(" + ")}</div>
      {active ? (
        <div className="flex">
          {[pair.keep, pair.other].map((side, index) => (
            <div key={side.id} className={cn("min-w-0 flex-1", index === 0 ? "border-r border-tomate-line pr-2" : "pl-2")}>
              <div className="mb-1 flex items-center gap-[7px]">
                <ClientAvatar seed={side.id} name={side.name} className="size-6 text-[9px]" />
                <span className="truncate text-[12.5px] font-medium">{nameOf(side)}</span>
              </div>
              <ChannelDots channels={side.channels} className="size-1.5" />
            </div>
          ))}
        </div>
      ) : (
        <div className="truncate text-[12.5px]">
          {nameOf(pair.keep)} · {nameOf(pair.other)}
        </div>
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
  const { keep, other } = pair;
  const ids = [keep.id, other.id];

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

  const newAddresses = other.addressKeys.filter((key) => !keep.addressKeys.includes(key)).length;
  const moved = [
    other.channels.length > 0 &&
      `${plural(other.channels.length, "canal", "canais")} (${other.channels.map((channel) => CHANNEL_LABEL[channel]).join(", ")})`,
    other.conversationsCount > 0 && plural(other.conversationsCount, "conversa", "conversas"),
    other.ordersCount > 0 && plural(other.ordersCount, "pedido", "pedidos"),
    newAddresses > 0 && plural(newAddresses, "endereço", "endereços"),
  ].filter(Boolean);

  return (
    <section className="flex flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
      <div className="rounded-[7px] border border-rule bg-surface px-4 py-2.5 text-[12.5px] leading-normal text-ink-2">
        <strong className="text-ink">Regra:</strong> Fica o cadastro mais antigo. Os campos exclusivos do outro são copiados. Tags
        são somadas. Endereços repetidos não se duplicam.
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SideCard side={keep} keep>
          <div className="text-[11px] font-medium text-success">✓ Fica — cadastro mais antigo</div>
        </SideCard>
        <SideCard side={other} keepName={nameOf(keep)} copies={{ phone: !keep.phone && Boolean(other.phone) }}>
          <div className="text-[11px] text-ink-3">Dados copiados para {nameOf(keep)}</div>
        </SideCard>
      </div>

      <div className="rounded-xl border border-success-line bg-success-lt px-[18px] py-3.5 text-[12.5px] leading-[1.55] text-success-ink">
        <div className="mb-1 font-medium">O que vai acontecer</div>
        Vão para <strong>{nameOf(keep)}:</strong> {moved.length > 0 ? `${moved.join(", ")}.` : "nenhum canal, conversa ou pedido."}
        {other.tags.length > 0 && " Tags somadas."}
        {other.addressKeys.length > newAddresses && " Endereços repetidos não se duplicam."} O cadastro de {nameOf(other)} será
        removido.
      </div>

      {error && <p className="text-[12px] text-tomate">{error}</p>}

      {blocked ? (
        <div className="overflow-hidden rounded-xl border-[1.5px] border-rule-soft bg-surface">
          <div className="border-b border-rule-soft bg-paper px-[18px] py-3 text-[11px] font-medium tracking-[0.06em] text-ink-3 uppercase">
            Não é possível unir
          </div>
          <div className="flex items-start gap-3 px-[18px] py-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-rule bg-surface-2">
              <LockIcon className="size-4 text-ink-3" aria-hidden />
            </div>
            <div className="flex-1">
              <div className="mb-1 text-[13px] font-medium">{blocked}</div>
              <div className="text-xs text-ink-3">São pessoas diferentes e os cadastros não podem ser unidos.</div>
            </div>
            <Button variant="outline" disabled>
              Unir cadastros
            </Button>
          </div>
        </div>
      ) : confirming ? (
        <div className="rounded-xl bg-ink px-6 py-5">
          <div className="mb-1.5 font-heading text-[15px] font-bold text-paper">Unir cadastros?</div>
          <p className="mb-3.5 text-[12.5px] leading-normal text-ink-3">
            Esta ação é irreversível. Os dados de {nameOf(other)} serão mesclados em {nameOf(keep)} e o cadastro de{" "}
            {nameOf(other)} será removido.
          </p>
          <div className="flex gap-2">
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
        <div className="flex items-center gap-2.5">
          <Button onClick={() => setConfirming(true)}>Unir cadastros</Button>
          <Button variant="outline" onClick={dismiss}>
            Não são a mesma pessoa
          </Button>
        </div>
      )}
    </section>
  );
}

function SideCard({
  side,
  keep = false,
  keepName,
  copies,
  children,
}: {
  side: DuplicateSide;
  keep?: boolean;
  keepName?: string;
  copies?: { phone: boolean };
  children: ReactNode;
}) {
  // No cadastro que sai, marca o que vai para o que fica.
  const moves = (amount: number, one: string, many: string) =>
    !keep && amount > 0 ? <span className="ml-1 text-[11px] font-medium text-success">→ {amount === 1 ? one : many}</span> : null;

  return (
    <div className={cn("overflow-hidden rounded-[10px] bg-surface", keep ? "border-2 border-success" : "border-[1.5px] border-rule-soft")}>
      <div
        className={cn(
          "flex items-center gap-2.5 border-b px-[18px] py-3.5",
          keep ? "border-success-line bg-success-lt" : "border-rule-soft bg-paper",
        )}
      >
        <ClientAvatar seed={side.id} name={side.name} className="size-9 text-[13px]" />
        <div className="min-w-0">
          <Link href={`/clientes/${side.id}`} className="block truncate font-heading text-[15px] font-bold hover:underline">
            {nameOf(side)}
          </Link>
          {children}
        </div>
      </div>
      <dl className="flex flex-col gap-2.5 px-[18px] py-4 text-[12.5px]">
        <Row label="Telefone">
          {side.phone ? (
            <span className="tabular-nums">{formatPhone(side.phone)}</span>
          ) : (
            <span className="text-ink-3 italic">não informado</span>
          )}
          {copies?.phone && <span className="ml-1 text-[11px] font-medium text-success">→ será copiado para {keepName}</span>}
        </Row>
        <Row label="Canais">
          <span className="flex items-center gap-1">
            <ChannelDots channels={side.channels} />
            {side.channels.length === 0 && <span className="text-ink-3 italic">nenhum</span>}
            {moves(side.channels.length, "será copiado", "serão copiados")}
          </span>
        </Row>
        <Row label="Pedidos">
          <span className="tabular-nums">{side.ordersCount}</span>
          {moves(side.ordersCount, "será copiado", "serão copiados")}
        </Row>
        <Row label="Conversas">
          <span className="tabular-nums">{side.conversationsCount}</span>
          {moves(side.conversationsCount, "será copiada", "serão copiadas")}
        </Row>
        <Row label="Cliente desde">{monthYear(side.firstSeenAt)}</Row>
      </dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="mb-0.5 text-[10.5px] font-medium tracking-[0.05em] text-ink-3 uppercase">{label}</dt>
      <dd className="flex items-center">{children}</dd>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-ink-3">{children}</div>;
}

function plural(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`;
}
