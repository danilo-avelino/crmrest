"use client";

import {
  CHANNEL_LABEL,
  type ContactDetail,
  type ConversationListItem,
  formatPhone,
  type OrderDto,
  phoneFromWhatsAppId,
  toE164,
  type UpdateContactRequest,
} from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon, MoreHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ClientAvatar, lastListHref, SectionLabel, useDuplicates, useIsAdmin } from "@/components/clients/bits";
import { AnonymizeDialog, ExportDialog } from "@/components/clients/lgpd-dialogs";
import { CHANNEL_DOT, StatusBadge } from "@/components/inbox/bits";
import { Cpf, Tags } from "@/components/inbox/client-panel";
import { ORDER_STATUS } from "@/components/inbox/order-card";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { currency, currencyWhole, dayTime, duration, fullDate, lastContact, monthYear, shortDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const PHONE_SOURCE: Record<string, string> = {
  informed_by_customer: "informado pelo cliente",
  channel: "informado pelo canal",
  agent: "cadastrado pela equipe",
};

const CONVERSATION_STATUS = {
  OPEN: { label: "Aberta", tone: "open" },
  PENDING: { label: "Pendente", tone: "pending" },
  RESOLVED: { label: "Resolvida", tone: "resolved" },
} as const;

// Cor do selo de cada status de pedido na aba Pedidos (o texto vem do card de pedido da Inbox).
const ORDER_TONE: Record<OrderDto["status"], "open" | "pending" | "resolved"> = {
  PLACED: "open",
  CONFIRMED: "pending",
  PREPARING: "pending",
  DISPATCHED: "resolved",
  DELIVERED: "resolved",
  CANCELED: "open",
};

/** Detalhe do cliente (board Clientes): cadastro à esquerda, métricas e abas Conversas/Pedidos à direita. */
export function ClientDetail({ id }: { id: string }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow(60_000);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"conversations" | "orders">("conversations");
  const [dialog, setDialog] = useState<"export" | "anonymize" | null>(null);
  const contact = useQuery({ queryKey: ["contact", id], queryFn: () => request<ContactDetail>(`/contacts/${id}`) });
  const admin = useIsAdmin(contact.data?.tenantId);
  const duplicates = useDuplicates();

  const save = async (body: UpdateContactRequest) => {
    const updated = await request<ContactDetail>(`/contacts/${id}`, { method: "PATCH", body });
    queryClient.setQueryData(["contact", id], updated);
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["contact-filters"] });
    void queryClient.invalidateQueries({ queryKey: ["contact-duplicates"] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  if (!contact.data) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 bg-paper text-[13px] text-ink-3">
        {contact.isError ? (
          <>
            {contact.error instanceof ApiError && contact.error.status === 404
              ? "Cliente não encontrado."
              : "Não foi possível carregar o cliente."}
            <Link href={lastListHref()} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Voltar para Clientes
            </Link>
          </>
        ) : (
          <LoaderCircleIcon className="size-4 animate-spin" aria-label="Carregando…" />
        )}
      </main>
    );
  }

  const data = contact.data;
  const anonymized = data.anonymized;
  const sameAs = duplicates.data?.find((pair) => pair.keep.id === id || pair.other.id === id);
  const twin = sameAs && (sameAs.keep.id === id ? sameAs.other : sameAs.keep);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <header className="shrink-0 border-b border-rule-soft bg-surface px-7 py-4">
        <Link href={lastListHref()} className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink-2">
          <ChevronLeftIcon className="size-3" aria-hidden />
          Clientes
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <ClientAvatar seed={data.id} name={data.name} anonymized={Boolean(anonymized)} className="size-[52px] text-lg" />
            {anonymized ? (
              <div>
                <h1 className="mb-0.5 font-heading text-xl font-semibold text-ink-3 italic">Cliente anonimizado</h1>
                <div className="text-xs text-ink-3 tabular-nums">
                  Dados pessoais removidos em {fullDate(anonymized.at)}
                  {anonymized.by && ` por ${anonymized.by}`}
                </div>
              </div>
            ) : (
              <div className="min-w-0">
                <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
                  <h1 className="font-heading text-xl font-bold tracking-[-0.3px]">{data.name ?? "Cliente sem nome"}</h1>
                  <Tags tags={data.tags} onChange={(tags) => save({ tags })} />
                </div>
                <div className="text-xs text-ink-3">
                  Cliente desde {monthYear(data.firstSeenAt)}
                  {data.lastSeenAt && (
                    <>
                      {" "}
                      · último contato <strong className="font-semibold text-ink">{lastContact(data.lastSeenAt, now)}</strong>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {!anonymized && (
            <div className="flex shrink-0 items-center gap-2">
              {data.latestConversationId ? (
                <Link href={`/inbox?conversa=${data.latestConversationId}`} className={buttonVariants()}>
                  Abrir conversa
                </Link>
              ) : (
                <Button disabled title="Este cliente ainda não tem conversas">
                  Abrir conversa
                </Button>
              )}
              <Button variant="outline" disabled={editing} onClick={() => setEditing(true)}>
                Editar
              </Button>
              {admin && (
                <DropdownMenu>
                  <DropdownMenuTrigger aria-label="Mais ações" className={buttonVariants({ variant: "outline", size: "icon" })}>
                    <MoreHorizontalIcon aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => setDialog("export")}>Exportar dados</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setDialog("anonymize")}>
                      Anonimizar cliente
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        {admin && sameAs && twin && (
          <div className="mt-2.5 flex items-center gap-2.5 rounded-lg border border-[#FDE68A] bg-warning-lt px-3.5 py-2">
            <TriangleAlertIcon className="size-[13px] shrink-0 text-[#D97706]" aria-hidden />
            <span className="text-xs text-warning-ink">
              Pode ser a mesma pessoa que{" "}
              <strong>
                {twin.name ?? "Cliente sem nome"}
                {twin.channels[0] && ` (${CHANNEL_LABEL[twin.channels[0]]})`}
              </strong>
            </span>
            <Link
              href={`/clientes/duplicados?par=${sameAs.keep.id},${sameAs.other.id}`}
              className="ml-1 text-xs text-tomate underline underline-offset-2"
            >
              Comparar
            </Link>
          </div>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-[360px] shrink-0 overflow-y-auto border-r border-rule-soft bg-surface px-6 py-5">
          {anonymized ? (
            <AnonymizedProfile ordersCount={data.metrics.ordersCount} />
          ) : editing ? (
            <EditForm
              contact={data}
              onCancel={() => setEditing(false)}
              onSave={async (body) => {
                await save(body);
                setEditing(false);
                toast("Cliente atualizado");
              }}
            />
          ) : (
            <Profile contact={data} onInformPhone={() => setEditing(true)} />
          )}
        </aside>

        <section className="flex-1 overflow-y-auto px-7 py-5">
          <div className="mb-5 grid grid-cols-3 gap-3">
            <Metric label="Pedidos">{data.metrics.ordersCount}</Metric>
            <Metric label="Total gasto">{currencyWhole(data.metrics.ordersTotal)}</Metric>
            <Metric label="Cliente há">{duration(data.firstSeenAt, now)}</Metric>
          </div>

          <div role="tablist" className="mb-4 flex border-b border-rule-soft">
            <TabButton active={tab === "conversations"} count={data.conversationsCount} onClick={() => setTab("conversations")}>
              Conversas
            </TabButton>
            <TabButton active={tab === "orders"} count={data.metrics.ordersCount} onClick={() => setTab("orders")}>
              Pedidos
            </TabButton>
          </div>
          {tab === "conversations" ? (
            <ConversationsTab contactId={id} now={now} />
          ) : (
            <OrdersTab contactId={id} total={data.metrics.ordersCount} now={now} />
          )}
        </section>
      </div>

      {admin && (
        <>
          <ExportDialog contact={data} open={dialog === "export"} onOpenChange={(open) => setDialog(open ? "export" : null)} />
          <AnonymizeDialog
            contact={data}
            open={dialog === "anonymize"}
            onOpenChange={(open) => setDialog(open ? "anonymize" : null)}
          />
        </>
      )}
    </main>
  );
}

function Profile({ contact, onInformPhone }: { contact: ContactDetail; onInformPhone: () => void }) {
  const address = (parts: (string | null)[]) => parts.filter(Boolean).join(", ");
  return (
    <>
      <div className="mb-5">
        <SectionLabel>Contato</SectionLabel>
        <div className="flex flex-col gap-2.5 text-[12.5px]">
          {contact.phone ? (
            <div>
              <div className="mb-0.5 tabular-nums">{formatPhone(contact.phone)}</div>
              {contact.phoneSource && (
                <div className="flex items-center gap-1 text-[11px] text-success">
                  <span className="size-1.5 rounded-full bg-success" />
                  {PHONE_SOURCE[contact.phoneSource] ?? contact.phoneSource}
                </div>
              )}
            </div>
          ) : (
            <div>
              <span className={cn("italic", contact.phoneStatus === "pending" ? "text-warning" : "text-ink-3")}>
                {contact.phoneStatus === "pending" ? "⚠ telefone pendente" : "telefone não informado"}
              </span>
              <div className="mt-px text-[11px] text-ink-3">
                Informe o telefone para qualificar o contato.{" "}
                <button type="button" onClick={onInformPhone} className="text-ink-2 underline-offset-2 hover:text-ink hover:underline">
                  Informar
                </button>
              </div>
            </div>
          )}
          {contact.email ? <div>{contact.email}</div> : <div className="text-ink-3 italic">E-mail não informado</div>}
          {contact.cpfMasked && <Cpf contactId={contact.id} masked={contact.cpfMasked} />}
        </div>
      </div>

      {contact.identities.length > 0 && (
        <ProfileSection title="Canais vinculados">
          <div className="flex flex-col gap-2">
            {contact.identities.map((identity) => (
              <div key={`${identity.channelType}-${identity.externalId}`} className="flex items-center gap-2 text-[12.5px]">
                <span className={cn("size-2 shrink-0 rounded-full", CHANNEL_DOT[identity.channelType])} />
                {CHANNEL_LABEL[identity.channelType]}
                {identity.username && ` @${identity.username}`}
                {identity.channelType === "WHATSAPP" && ` ${formatPhone(phoneFromWhatsAppId(identity.externalId))}`}
              </div>
            ))}
          </div>
        </ProfileSection>
      )}

      {contact.addresses.length > 0 && (
        <ProfileSection title={contact.addresses.length === 1 ? "Endereço" : "Endereços"}>
          <div className="flex flex-col gap-1.5">
            {contact.addresses.map((item) => (
              <div key={item.id} className="rounded-[7px] bg-paper px-3.5 py-3">
                {item.label && <div className="mb-1 text-[11px] font-semibold text-ink-3">{item.label}</div>}
                <div className="text-[12.5px] leading-[1.55]">
                  {address([item.street, item.number, item.complement])}
                  <br />
                  {[item.district, `${item.city} - ${item.state}`].filter(Boolean).join(" · ")}
                  {item.zipCode && (
                    <>
                      <br />
                      <span className="tabular-nums">CEP {item.zipCode}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </ProfileSection>
      )}

      {contact.notes && (
        <ProfileSection title="Observações">
          <p className="text-[12.5px] leading-[1.55] whitespace-pre-wrap text-ink-2 italic">{contact.notes}</p>
        </ProfileSection>
      )}
    </>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5 border-t border-surface-2 pt-4 last:mb-0">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
}

function AnonymizedProfile({ ordersCount }: { ordersCount: number }) {
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {["Nome", "Telefone", "E-mail", "CPF", "Endereços", "Canais vinculados"].map((field) => (
        <div key={field} className="flex justify-between">
          <span className="text-ink-3">{field}</span>
          <span className="text-rule italic">removido</span>
        </div>
      ))}
      <div className="flex justify-between">
        <span className="text-ink-3">Pedidos</span>
        <span className="tabular-nums">{ordersCount} (sem identificação)</span>
      </div>
    </div>
  );
}

/** Edição do cadastro (board Clientes → "Modo edição"). */
function EditForm({
  contact,
  onSave,
  onCancel,
}: {
  contact: ContactDetail;
  onSave: (body: UpdateContactRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(contact.name ?? "");
  const [phone, setPhone] = useState(contact.phone ? formatPhone(contact.phone) : "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [errors, setErrors] = useState<{ phone?: string; email?: string; form?: string }>({});

  const [submit, saving] = usePendingAction(async () => {
    const e164 = phone.trim() ? toE164(phone) : null;
    const next = {
      phone: phone.trim() && !e164 ? "Telefone inválido. Use DDD + número." : undefined,
      email: email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "E-mail inválido." : undefined,
    };
    setErrors(next);
    if (next.phone || next.email) return;
    try {
      await onSave({
        ...(name.trim() && { name: name.trim() }),
        // Só envia o que mudou: reenviar o mesmo telefone apagaria a origem ("informado pelo cliente").
        ...(e164 !== contact.phone && { phone: e164 }),
        ...(email.trim() !== (contact.email ?? "") && { email: email.trim() || null }),
        ...(notes.trim() !== (contact.notes ?? "") && { notes: notes.trim() || null }),
      });
    } catch (failure) {
      setErrors({ form: failure instanceof ApiError ? failure.message : "Não foi possível salvar." });
    }
  });

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field id="client-name" label="Nome">
        <Input id="client-name" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field id="client-phone" label="Telefone" error={errors.phone}>
        <Input
          id="client-phone"
          autoFocus={!contact.phone}
          value={phone}
          placeholder="(11) 98765-4321"
          aria-invalid={Boolean(errors.phone) || undefined}
          onChange={(event) => setPhone(event.target.value)}
        />
      </Field>
      <Field id="client-email" label="E-mail" error={errors.email}>
        <Input
          id="client-email"
          type="email"
          value={email}
          placeholder="email@exemplo.com"
          aria-invalid={Boolean(errors.email) || undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field id="client-notes" label="Observações">
        <textarea
          id="client-notes"
          rows={3}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
          className="w-full resize-none rounded-lg border border-input bg-surface px-3 py-2 text-[13px] leading-normal outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8"
        />
      </Field>
      {errors.form && <FieldError>{errors.form}</FieldError>}
      <div className="flex gap-2 pt-1">
        <Button type="submit" loading={saving}>
          Salvar
        </Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-[11.5px]">
        {label}
      </Label>
      {children}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-center gap-[5px] text-[11.5px] text-tomate">
      <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-rule-soft bg-surface px-[18px] py-4">
      <div className="mb-1.5 text-[10.5px] font-medium tracking-[0.05em] text-ink-3 uppercase">{label}</div>
      <div className="font-heading text-[28px] leading-none font-bold tracking-[-0.5px] tabular-nums">{children}</div>
    </div>
  );
}

function TabButton({ active, count, onClick, children }: { active: boolean; count: number; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-[13px]",
        active ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
      )}
    >
      {children}
      <span className={cn("rounded-[3px] bg-surface-2 px-[5px] py-px text-[11px] font-semibold tabular-nums", active ? "text-ink-2" : "text-ink-3")}>
        {count}
      </span>
    </button>
  );
}

function ConversationsTab({ contactId, now }: { contactId: string; now: number }) {
  const { request } = useAuth();
  const conversations = useQuery({
    queryKey: ["contact-conversations", contactId],
    queryFn: () => request<ConversationListItem[]>(`/contacts/${contactId}/conversations`),
  });

  if (!conversations.data) return <TabState query={conversations} />;
  if (conversations.data.length === 0) return <p className="py-10 text-center text-[12.5px] text-ink-3">Nenhuma conversa ainda.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {conversations.data.map((conversation) => {
        const status = CONVERSATION_STATUS[conversation.status];
        const open = conversation.status === "OPEN";
        return (
          <Link
            key={conversation.id}
            href={`/inbox?conversa=${conversation.id}`}
            className={cn(
              "flex items-center gap-3 rounded-xl border border-rule-soft bg-surface px-4 py-3.5 hover:bg-[#F7F6F4]",
              open && "border-l-[3px] border-l-tomate",
            )}
          >
            <span className={cn("size-2 shrink-0 rounded-full", CHANNEL_DOT[conversation.channel.type])} title={CHANNEL_LABEL[conversation.channel.type]} />
            <div className="min-w-0 flex-1">
              <div className="mb-[3px] flex items-center gap-2 text-[11px] text-ink-3">
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                <span className="tabular-nums">{shortDay(conversation.lastMessageAt ?? conversation.createdAt, now)}</span>
                {conversation.assignedUser && <span>· {conversation.assignedUser.name}</span>}
              </div>
              <div className={cn("truncate text-[12.5px]", open ? "text-ink-2" : "text-ink-3")}>
                {conversation.lastMessage?.preview ?? "Sem mensagens"}
              </div>
            </div>
            <ChevronRightIcon className="size-3 shrink-0 text-rule" aria-hidden />
          </Link>
        );
      })}
    </div>
  );
}

function OrdersTab({ contactId, total, now }: { contactId: string; total: number; now: number }) {
  const { request } = useAuth();
  const [expanded, setExpanded] = useState<string | null>(null);
  const orders = useQuery({
    queryKey: ["contact-orders", contactId],
    queryFn: () => request<OrderDto[]>(`/contacts/${contactId}/orders`),
  });

  if (!orders.data) return <TabState query={orders} />;
  if (orders.data.length === 0) return <p className="py-10 text-center text-[12.5px] text-ink-3">Nenhum pedido ainda.</p>;
  const th = "border-b border-rule-soft px-3 py-2.5 text-left text-[11px] font-medium tracking-[0.05em] text-ink-3 uppercase";
  const td = "border-b border-surface-2 px-3 py-[13px] text-[12.5px]";
  return (
    <div className="overflow-hidden rounded-xl border border-rule-soft bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-paper">
            <th className={th}>Pedido</th>
            <th className={th}>Origem</th>
            <th className={th}>Data e hora</th>
            <th className={cn(th, "text-right")}>Total</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.data.flatMap((order) => {
            const open = expanded === order.id;
            const toggle = () => setExpanded(open ? null : order.id);
            const row = (
              <tr
                key={order.id}
                onClick={toggle}
                aria-expanded={open}
                className={cn("cursor-pointer", open ? "bg-tomate-lt" : "hover:bg-[#F7F6F4]")}
              >
                <td className={cn(td, "tabular-nums", open && "border-b-0 font-semibold shadow-[inset_3px_0_0_var(--color-tomate)]")}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle();
                    }}
                    className="text-left"
                  >
                    #{order.displayCode ?? order.id.slice(0, 6)}
                  </button>
                </td>
                <td className={cn(td, open && "border-b-0")}>
                  <span className="flex items-center gap-[5px] text-ink-2">
                    <span className={cn("size-2 rounded-full", CHANNEL_DOT[order.channelType])} />
                    {CHANNEL_LABEL[order.channelType]}
                  </span>
                </td>
                <td className={cn(td, "text-ink-2 tabular-nums", open && "border-b-0")}>{dayTime(order.placedAt, now)}</td>
                <td className={cn(td, "text-right tabular-nums", open && "border-b-0 font-medium")}>{currency(order.total)}</td>
                <td className={cn(td, open && "border-b-0")}>
                  <StatusBadge tone={ORDER_TONE[order.status]}>{ORDER_STATUS[order.status].label}</StatusBadge>
                </td>
              </tr>
            );
            if (!open) return [row];
            return [
              row,
              <tr key={`${order.id}-items`} className="bg-tomate-lt">
                <td colSpan={5} className="border-b border-tomate-line px-4 pb-3.5 pl-5">
                  <div className="overflow-hidden rounded-[7px] border border-tomate-line bg-surface text-xs">
                    {order.items.map((item, index) => (
                      <div key={index} className="flex justify-between border-b border-surface-2 px-3.5 py-2.5">
                        <span className="text-ink-2">
                          {item.quantity}× {item.name}
                        </span>
                        <span className="font-medium tabular-nums">{currency(Number(item.unitPrice) * item.quantity)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between border-b border-surface-2 bg-paper px-3.5 py-2.5 text-[11.5px] text-ink-3">
                      <span>Taxa de entrega</span>
                      <span className="tabular-nums">{currency(order.deliveryFee)}</span>
                    </div>
                    <div className="flex justify-between bg-paper px-3.5 py-2.5 text-[12.5px]">
                      <span className="font-semibold">Total</span>
                      <span className="font-bold tabular-nums">{currency(order.total)}</span>
                    </div>
                  </div>
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
      {total > orders.data.length && (
        <p className="border-t border-surface-2 px-3 py-2.5 text-[11.5px] text-ink-3">
          Mostrando os {orders.data.length} pedidos mais recentes de {total}.
        </p>
      )}
    </div>
  );
}

function TabState({ query }: { query: { isError: boolean; refetch: () => unknown } }) {
  if (!query.isError) {
    return (
      <div className="flex justify-center py-10 text-ink-3">
        <LoaderCircleIcon className="size-4 animate-spin" aria-label="Carregando…" />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[12.5px] text-ink-3">
      Não foi possível carregar.
      <Button variant="outline" size="sm" onClick={() => query.refetch()}>
        Tentar novamente
      </Button>
    </div>
  );
}
