"use client";

import {
  CHANNEL_LABEL,
  type ContactDetail,
  formatPhone,
  phoneFromWhatsAppId,
  toE164,
  type UpdateContactRequest,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, IdCardIcon, LoaderCircleIcon, MailIcon, MapPinIcon, PencilIcon, PhoneIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar, CHANNEL_DOT } from "@/components/inbox/bits";
import { CurrentOrder } from "@/components/inbox/current-order";
import { ORDER_STATUS } from "@/components/inbox/order-card";
import { sourcesText } from "@/components/orders/customer-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePendingAction } from "@/hooks/use-pending-action";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { currency, dayLabel, tenure } from "@/lib/format";
import { cn } from "@/lib/utils";

const PHONE_SOURCE: Record<string, string> = {
  informed_by_customer: "informado pelo cliente",
  channel: "informado pelo canal",
  agent: "cadastrado pela equipe",
};

/** Painel do cliente (coluna de 344px do board Inbox). */
export function ClientPanel({ contactId, conversationId }: { contactId: string; conversationId: string }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const contact = useQuery({
    queryKey: ["contact", contactId],
    queryFn: () => request<ContactDetail>(`/contacts/${contactId}`),
  });

  const save = async (body: UpdateContactRequest) => {
    const updated = await request<ContactDetail>(`/contacts/${contactId}`, { method: "PATCH", body });
    queryClient.setQueryData(["contact", contactId], updated);
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  if (!contact.data) {
    return (
      <aside className="flex w-[344px] shrink-0 items-center justify-center bg-surface text-ink-3">
        {contact.isError ? "Não foi possível carregar o cliente." : <LoaderCircleIcon className="size-4 animate-spin" aria-label="Carregando…" />}
      </aside>
    );
  }
  const data = contact.data;

  return (
    <aside className="flex w-[344px] shrink-0 flex-col overflow-y-auto bg-surface">
      <div className="shrink-0 border-b border-rule px-4 pt-4 pb-3.5">
        <div className="flex items-start gap-2.5">
          <Avatar seed={data.id} name={data.name} className="size-11 text-[15px]" />
          <div className="min-w-0 flex-1">
            <h3 className="mb-1 truncate font-heading text-[16px] font-bold tracking-[-0.3px]">{data.name ?? "Cliente sem nome"}</h3>
            <Tags tags={data.tags} onChange={(tags) => save({ tags })} />
          </div>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={editing ? "Fechar edição" : "Editar cliente"}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? <XIcon aria-hidden /> : <PencilIcon aria-hidden />}
          </Button>
        </div>
      </div>

      {editing ? (
        <EditForm
          contact={data}
          onSave={async (body) => {
            await save(body);
            setEditing(false);
          }}
        />
      ) : (
        <>
          <CurrentOrder conversationId={conversationId} />
          <Section title="Contato">
            <Row icon={PhoneIcon}>
              {data.phone ? (
                <div>
                  <div className="tabular-nums">{formatPhone(data.phone)}</div>
                  {data.phoneSource && (
                    <div className="mt-px flex items-center gap-1 text-[10.5px] text-success">
                      <CheckCircle2Icon className="size-3" aria-hidden />
                      {PHONE_SOURCE[data.phoneSource] ?? data.phoneSource}
                    </div>
                  )}
                </div>
              ) : (
                // O telefone é o que qualifica o contato; o resto vem dos canais e pedidos.
                <div>
                  <span className={cn("italic", data.phoneStatus === "pending" ? "text-warning" : "text-ink-3")}>
                    {data.phoneStatus === "pending" ? "⚠ telefone pendente" : "telefone não informado"}
                  </span>
                  <div className="mt-px text-[10.5px] text-ink-3">
                    Informe o telefone para qualificar o contato.{" "}
                    <button
                      type="button"
                      onClick={() => setEditing(true)}
                      className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                    >
                      Informar
                    </button>
                  </div>
                </div>
              )}
            </Row>
            {data.email && <Row icon={MailIcon}>{data.email}</Row>}
            {data.cpfMasked && (
              <Row icon={IdCardIcon}>
                <Cpf contactId={data.id} masked={data.cpfMasked} />
              </Row>
            )}
          </Section>

          {data.identities.length > 0 && (
            <Section title="Canais vinculados">
              {data.identities.map((identity) => (
                <div key={`${identity.channelType}-${identity.externalId}`} className="flex items-center gap-[7px]">
                  <span className={cn("size-2 shrink-0 rounded-full", CHANNEL_DOT[identity.channelType])} />
                  <span className="text-[12.5px]">
                    {CHANNEL_LABEL[identity.channelType]}
                    {identity.username && ` @${identity.username}`}
                    {identity.channelType === "WHATSAPP" && ` ${formatPhone(phoneFromWhatsAppId(identity.externalId))}`}
                  </span>
                </div>
              ))}
            </Section>
          )}

          {data.addresses[0] && (
            <Section title="Endereço de entrega">
              <Row icon={MapPinIcon}>
                <div className="leading-normal">
                  {[data.addresses[0].street, data.addresses[0].number, data.addresses[0].complement].filter(Boolean).join(", ")}
                  <br />
                  <span className="text-ink-2">
                    {[data.addresses[0].district, `${data.addresses[0].city} - ${data.addresses[0].state}`].filter(Boolean).join(" · ")}
                  </span>
                  {data.addresses[0].zipCode && (
                    <>
                      <br />
                      <span className="text-ink-3 tabular-nums">CEP {data.addresses[0].zipCode}</span>
                    </>
                  )}
                </div>
              </Row>
            </Section>
          )}

          <History contact={data} />
        </>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-rule px-4 py-3">
      <div className="text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{title}</div>
      {children}
    </div>
  );
}

function Row({ icon: Icon, children }: { icon: typeof PhoneIcon; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px]">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
      {children}
    </div>
  );
}

export function Tags({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [change] = usePendingAction(onChange);

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="group inline-flex items-center gap-0.5 rounded-sm border border-dashed border-tag-line px-[7px] py-0.5 text-[10.5px] text-ink-2">
          {tag}
          <button
            type="button"
            aria-label={`Remover tag ${tag}`}
            onClick={() => change(tags.filter((t) => t !== tag))}
            className="hidden text-ink-3 group-hover:inline hover:text-ink"
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={draft}
          maxLength={40}
          aria-label="Nova tag"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setAdding(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setAdding(false);
            if (event.key === "Enter" && draft.trim()) {
              change([...tags, draft.trim()]);
              setDraft("");
              setAdding(false);
            }
          }}
          className="w-24 rounded-sm border border-dashed border-ink-3 px-[7px] py-0.5 text-[10.5px] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-sm border border-dashed border-tag-line px-[7px] py-0.5 text-[10.5px] text-ink-3 hover:text-ink-2"
        >
          + tag
        </button>
      )}
    </div>
  );
}

/** CPF mascarado; o completo só sob demanda e com registro em auditoria (§8). */
export function Cpf({ contactId, masked }: { contactId: string; masked: string }) {
  const { request } = useAuth();
  const [full, setFull] = useState<string | null>(null);
  const [reveal, revealing] = usePendingAction(async () => {
    const { cpf } = await request<{ cpf: string | null }>(`/contacts/${contactId}/cpf`, { method: "POST" });
    setFull(cpf);
  });

  if (full) {
    return (
      <span className="tabular-nums" title="Esta visualização foi registrada">
        {`${full.slice(0, 3)}.${full.slice(3, 6)}.${full.slice(6, 9)}-${full.slice(9)}`}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 tabular-nums">
      {masked}
      <button
        type="button"
        onClick={() => reveal()}
        disabled={revealing}
        className="text-[11px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline disabled:cursor-not-allowed"
      >
        {revealing ? "Carregando…" : "Ver"}
      </button>
    </span>
  );
}

/** Cadastro simples: a equipe só ajusta o nome e informa o telefone; o resto vem dos canais e pedidos. */
function EditForm({ contact, onSave }: { contact: ContactDetail; onSave: (body: UpdateContactRequest) => Promise<void> }) {
  const [name, setName] = useState(contact.name ?? "");
  const [phone, setPhone] = useState(contact.phone ? formatPhone(contact.phone) : "");
  const [error, setError] = useState<string | null>(null);

  const [submit, saving] = usePendingAction(async () => {
    setError(null);
    const e164 = phone.trim() ? toE164(phone) : null;
    if (phone.trim() && !e164) return setError("Telefone inválido. Use DDD + número.");
    try {
      await onSave({
        ...(name.trim() && { name: name.trim() }),
        // Só envia o que mudou: reenviar o mesmo telefone apagaria a origem ("informado pelo cliente").
        ...(e164 !== contact.phone && { phone: e164 }),
      });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível salvar.");
    }
  });

  const field = (id: string, label: string, input: ReactNode) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {input}
    </div>
  );

  return (
    <form
      className="flex flex-col gap-2.5 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {field("contact-name", "Nome", <Input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} />)}
      {field(
        "contact-phone",
        "Telefone",
        <Input id="contact-phone" autoFocus={!contact.phone} value={phone} placeholder="(11) 98765-4321" onChange={(e) => setPhone(e.target.value)} />,
      )}
      {error && (
        <p role="alert" className="text-[11px] text-tomate">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" loading={saving}>
        Salvar
      </Button>
    </form>
  );
}

function History({ contact }: { contact: ContactDetail }) {
  const now = useNow(60_000);
  return (
    <>
      <div className="border-b border-rule px-4 py-3">
        <div className="mb-2.5 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Histórico</div>
        <div className="grid grid-cols-3 gap-2">
          {[
            [String(contact.metrics.ordersCount), "pedidos"],
            [String(Math.round(Number(contact.metrics.ordersTotal))), "reais gastos"],
            [tenure(contact.firstSeenAt, now), "como cliente"],
          ].map(([value, label]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <div className="font-heading text-[20px] leading-none font-bold tabular-nums">{value}</div>
              <div className="text-[10.5px] text-ink-3">{label}</div>
            </div>
          ))}
        </div>
        {/* Os pedidos somam todas as fontes ligadas ao cliente (iFood, Cardápio Web...). */}
        {contact.metrics.ordersBySource.length > 1 && (
          <div className="mt-2 text-[11px] text-ink-3">{sourcesText({ bySource: contact.metrics.ordersBySource })}</div>
        )}
      </div>
      {contact.recentOrders.length > 0 && (
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Últimos pedidos</div>
          <div className="overflow-hidden rounded-lg border border-rule">
            {contact.recentOrders.map((order) => {
              const status = ORDER_STATUS[order.status];
              const active = order.status !== "DELIVERED" && order.status !== "CANCELED";
              return (
                <div
                  key={order.id}
                  className={cn("flex items-center justify-between border-b border-rule px-3 py-[9px] last:border-b-0", active && "bg-tomate-lt")}
                >
                  <div>
                    <div className="text-[12px] font-medium tabular-nums">#{order.displayCode ?? order.id.slice(0, 6)}</div>
                    <div className="text-[10.5px] text-ink-3">{dayLabel(order.placedAt, now)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[12px] font-semibold tabular-nums">{currency(order.total)}</div>
                    <span className={cn("text-[10px]", status.className)}>{status.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
