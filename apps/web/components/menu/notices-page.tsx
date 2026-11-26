"use client";

import { useQuery } from "@tanstack/react-query";
import { ClockIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { BLOCK, ErrorNote, FilterChip, Headline, loadError, MenuPage, PageHeader, StatusBadge, TEXTAREA_CLASS, Toggle } from "@/components/menu/bits";
import { PHOTO_TYPES, useMenuActions, useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { hourText, minuteText, type Notice, plural, shortDate, WEEK_ORDER, WEEKDAY_SHORT, whenText } from "@/lib/menu-backstage";
import { cn } from "@/lib/utils";

type Filter = "all" | "LIVE" | "OUT_OF_HOURS" | "PAUSED";
const FILTER_LABEL: Record<Filter, string> = { all: "Todos", LIVE: "No ar", OUT_OF_HOURS: "Fora do horário", PAUSED: "Pausados" };
/** Fora do horário inclui os que passaram da data (não voltam sozinhos). */
const filterOf = (n: Notice): Filter => (n.status.kind === "LIVE" ? "LIVE" : n.status.kind === "PAUSED" ? "PAUSED" : "OUT_OF_HOURS");

function useNotices() {
  const { request } = useAuth();
  const tenantId = useTenantId();
  return useQuery({ queryKey: ["menu-notices", tenantId], queryFn: () => request<Notice[]>(`/menu/${tenantId}/notices`), enabled: Boolean(tenantId), retry: false });
}

const clockNow = () =>
  new Intl.DateTimeFormat("pt-BR", { weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" })
    .format(new Date())
    .replace(/-feira/, "")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(":", "h");

/** N5: faixas com imagem no topo do cardápio público, nos dias e horários escolhidos, e a prévia ao lado. */
export function NoticesPage() {
  const notices = useNotices();
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<Notice | "new" | null>(null);
  const header = (
    <PageHeader title="Avisos no cardápio" description="Faixas com imagem no topo do cardápio público, nos dias e horários que você escolher.">
      <Button onClick={() => setEditing("new")}>
        <PlusIcon aria-hidden /> Novo aviso
      </Button>
    </PageHeader>
  );
  const dialog = editing && <NoticeDialog notice={editing === "new" ? null : editing} onClose={() => setEditing(null)} />;

  if (notices.isPending) {
    return (
      <MenuPage>
        {header}
        <div className={cn(BLOCK, "p-8 text-center text-ink-3")} aria-busy>
          Carregando os avisos…
        </div>
      </MenuPage>
    );
  }
  if (notices.isError) {
    const failure = loadError(notices.error);
    return (
      <MenuPage>
        {header}
        <ErrorNote action={!failure.forbidden && <Button size="sm" variant="outline" onClick={() => notices.refetch()}>Tentar de novo</Button>}>
          {failure.forbidden ? failure.text : "Não foi possível carregar os avisos. O cardápio público continua mostrando os que estão no ar."}
        </ErrorNote>
      </MenuPage>
    );
  }

  const all = notices.data;
  const live = all.filter((n) => n.status.kind === "LIVE");
  const shown = all.filter((n) => filter === "all" || filterOf(n) === filter);
  if (!all.length) {
    return (
      <MenuPage>
        {header}
        <section className={cn(BLOCK, "flex flex-col items-center gap-3 px-6 py-12 text-center")}>
          <p className="font-heading text-[22px] font-bold">Nenhum aviso ainda · 0 avisos</p>
          <p className="max-w-[520px] text-ink-2">Anuncie uma novidade, um horário diferente ou uma promoção com uma faixa no topo do cardápio público.</p>
          <Button onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden /> Novo aviso
          </Button>
        </section>
        {dialog}
      </MenuPage>
    );
  }
  return (
    <MenuPage>
      {header}
      <Headline
        value={`${plural(live.length, "aviso no ar", "avisos no ar")} agora`}
        sub={live.length ? `${clockNow()} · o cliente vê ${live.length === 1 ? "o aviso" : `os ${live.length} em sequência`} no topo` : `${clockNow()} · nenhum aviso aparece no cardápio agora`}
      >
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar avisos">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} {f === "all" ? all.length : all.filter((n) => filterOf(n) === f).length}
            </FilterChip>
          ))}
        </div>
      </Headline>
      <div className="flex items-start gap-4">
        <ul className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" aria-label="Avisos">
          {shown.map((n) => (
            <li key={n.id}>
              <NoticeCard notice={n} onEdit={() => setEditing(n)} />
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="flex h-full min-h-60 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-tag-line text-ink-2 hover:bg-surface"
            >
              <PlusIcon className="size-4" aria-hidden /> Novo aviso
            </button>
          </li>
        </ul>
        <Preview live={live} />
      </div>
      {dialog}
    </MenuPage>
  );
}

function statusView(n: Notice): { label: string; tone: "success" | "warning" | "muted"; aside: string | null } {
  switch (n.status.kind) {
    case "LIVE":
      return { label: "No ar", tone: "success", aside: n.status.until ? `sai às ${hourText(n.status.until)}` : n.endsOn ? `até ${shortDate(n.endsOn)}` : null };
    case "OUT_OF_HOURS":
      return { label: "Fora do horário", tone: "warning", aside: n.status.nextAt ? `volta ${whenText(n.status.nextAt)}` : null };
    case "ENDED":
      return { label: "Encerrado", tone: "muted", aside: `terminou em ${shortDate(n.status.since)}` };
    default:
      return { label: "Pausado", tone: "muted", aside: n.pausedBy ? `pausado por ${n.pausedBy}` : null };
  }
}

function NoticeCard({ notice, onEdit }: { notice: Notice; onEdit: () => void }) {
  const { call } = useMenuActions();
  const view = statusView(notice);
  const hours = notice.startMinute != null && notice.endMinute != null ? `${minuteText(notice.startMinute)} às ${minuteText(notice.endMinute)}` : "O dia todo";
  const days = notice.weekdays.length ? notice.weekdays : WEEK_ORDER;
  return (
    <article className={cn(BLOCK, "flex h-full flex-col overflow-hidden")}>
      <div className="relative h-40 bg-surface-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- imagem do restaurante vinda do armazenamento */}
        {notice.photoUrl ? <img src={notice.photoUrl} alt="" className="size-full object-cover" /> : <span className="absolute bottom-2 left-3 text-[11.5px] text-ink-3">Sem imagem</span>}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className={cn("font-semibold", notice.status.kind === "PAUSED" && "text-ink-2")}>{notice.title}</h3>
            {notice.body && <p className="text-[12.5px] text-ink-2">{notice.body}</p>}
          </div>
          <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-2.5 text-[12.5px]">
          <span className="flex gap-0.5" aria-label={`Dias: ${days.map((d) => WEEKDAY_SHORT[d]).join(", ")}`}>
            {WEEK_ORDER.map((d) => (
              <span key={d} className={cn("flex size-[18px] items-center justify-center rounded-sm text-[10px] font-semibold", days.includes(d) ? "bg-ink text-paper" : "bg-surface-2 text-ink-3")}>
                {WEEKDAY_SHORT[d]![0]}
              </span>
            ))}
          </span>
          <span className="flex items-center gap-1 text-ink-2">
            <ClockIcon className="size-3.5" aria-hidden /> {hours}
          </span>
          {view.aside && <span className={cn("ml-auto", notice.status.kind === "LIVE" ? "text-success-ink" : "text-ink-3")}>{view.aside}</span>}
        </div>
        <div className="mt-auto flex items-center gap-2">
          <span className="flex items-center gap-2 text-[13px]">
            <Toggle on={notice.active} label={`${notice.active ? "Desligar" : "Ligar"} ${notice.title}`} onToggle={() => call(`/notices/${notice.id}/active`, "PATCH", { active: !notice.active })} />
            {notice.active ? "Ligado" : "Desligado"}
          </span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={onEdit}>
            <PencilIcon aria-hidden /> Editar
          </Button>
        </div>
      </div>
    </article>
  );
}

/** Prévia do topo do cardápio público com os avisos no ar agora (passam sozinhos a cada 5 s). */
function Preview({ live }: { live: Notice[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (live.length < 2) return;
    const timer = window.setInterval(() => setIndex((i) => i + 1), 5_000);
    return () => window.clearInterval(timer);
  }, [live.length]);
  const current = live[index % Math.max(1, live.length)];
  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-2" aria-label="Prévia no cardápio público">
      <p className="text-[13px] font-semibold">Prévia no cardápio público · agora</p>
      <div className={cn(BLOCK, "flex flex-col gap-3 p-3")}>
        {current ? (
          <>
            <button type="button" className="overflow-hidden rounded-lg border border-rule text-left" onClick={() => setIndex(index + 1)} aria-label="Ver o próximo aviso">
              <div className="h-32 bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- imagem do restaurante vinda do armazenamento */}
                {current.photoUrl && <img src={current.photoUrl} alt="" className="size-full object-cover" />}
              </div>
              <div className="px-3 py-2">
                <p className="font-semibold">{current.title}</p>
                {current.body && <p className="text-[12.5px] text-ink-2">{current.body}</p>}
              </div>
            </button>
            <div className="flex justify-center gap-1" aria-hidden>
              {live.map((n, i) => (
                <span key={n.id} className={cn("h-1.5 rounded-full", i === index % live.length ? "w-4 bg-ink" : "w-1.5 bg-rule")} />
              ))}
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-[12.5px] text-ink-3">Nenhum aviso no ar agora: o cardápio abre direto nas categorias.</p>
        )}
        <div className="flex flex-col gap-2" aria-hidden>
          <div className="h-12 rounded-lg bg-surface-2" />
          <div className="h-12 rounded-lg bg-surface-2" />
        </div>
      </div>
      <p className="text-[12px] text-ink-3">Os avisos passam sozinhos a cada 5 segundos; o cliente também pode arrastar.</p>
    </aside>
  );
}

const toHHMM = (m: number | null) => (m == null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const fromHHMM = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);

function NoticeDialog({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  const { call, uploadTo, error } = useMenuActions();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<Notice | null>(notice);
  const [title, setTitle] = useState(notice?.title ?? "");
  const [body, setBody] = useState(notice?.body ?? "");
  const [weekdays, setWeekdays] = useState<number[]>(notice?.weekdays ?? []);
  const [allDay, setAllDay] = useState(notice ? notice.startMinute == null : true);
  const [start, setStart] = useState(toHHMM(notice?.startMinute ?? null) || "18:00");
  const [end, setEnd] = useState(toHHMM(notice?.endMinute ?? null) || "20:00");
  const [endsOn, setEndsOn] = useState(notice?.endsOn ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    setProblem(null);
    if (!title.trim()) return setProblem("Dê um título ao aviso.");
    const s = allDay ? null : fromHHMM(start);
    const e = allDay ? null : fromHHMM(end);
    if (!allDay && (s == null || e == null || s === e)) return setProblem("Horário: informe o início e o fim (diferentes).");
    const payload = { title: title.trim(), body: body.trim() || null, weekdays, startMinute: s, endMinute: e, endsOn: endsOn || null };
    const done = saved ? await call<Notice>(`/notices/${saved.id}`, "PUT", payload) : await call<Notice>("/notices", "POST", payload);
    if (!done) return;
    toast(saved ? "Aviso salvo." : "Aviso criado. Agora envie a imagem.");
    if (saved) onClose();
    else setSaved(done.data);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[480px]">
        <div className="flex flex-col gap-3 px-5 py-4">
          <DialogTitle>{notice ? "Editar aviso" : "Novo aviso"}</DialogTitle>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="n-title">Título</Label>
            <Input id="n-title" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="n-body">Texto</Label>
            <textarea id="n-body" rows={2} maxLength={240} className={TEXTAREA_CLASS} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-16 w-24 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-[11px] text-ink-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- imagem do restaurante vinda do armazenamento */}
              {saved?.photoUrl ? <img src={saved.photoUrl} alt="" className="size-full object-cover" /> : "Imagem"}
            </div>
            <div className="flex flex-col gap-1">
              <Button size="sm" variant="outline" disabled={!saved} onClick={() => fileRef.current?.click()}>
                {saved?.photoUrl ? "Trocar imagem" : "Enviar imagem"}
              </Button>
              <span className="text-[12px] text-ink-3">{saved ? "JPG, PNG ou WEBP, até 1 MB" : "Salve o aviso para enviar a imagem."}</span>
              <input
                ref={fileRef}
                type="file"
                accept={PHOTO_TYPES.join(",")}
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file || !saved) return;
                  const done = await uploadTo<Notice>(`/notices/${saved.id}/photo`, file);
                  if (done) {
                    setSaved(done);
                    toast("Imagem enviada.");
                  }
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Dias</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dias da semana">
              {WEEK_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={weekdays.includes(d)}
                  onClick={() => setWeekdays(weekdays.includes(d) ? weekdays.filter((w) => w !== d) : [...weekdays, d])}
                  className={cn("h-8 min-w-10 rounded-md border px-2 text-[12.5px]", weekdays.includes(d) ? "border-ink bg-ink font-semibold text-paper" : "border-rule bg-surface text-ink-2")}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
            <span className="text-[12px] text-ink-3">Nenhum marcado = todos os dias.</span>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex h-9 items-center gap-2 text-[13px]">
              <input type="checkbox" className="size-4 accent-ink" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> O dia todo
            </label>
            {!allDay && (
              <>
                <Input type="time" aria-label="Das" className="w-28" value={start} onChange={(e) => setStart(e.target.value)} />
                <span className="pb-2 text-ink-3">às</span>
                <Input type="time" aria-label="Até" className="w-28" value={end} onChange={(e) => setEnd(e.target.value)} />
              </>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="n-ends">Termina em</Label>
            <Input id="n-ends" type="date" className="w-44" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            <span className="text-[12px] text-ink-3">Vazio = sem data para acabar.</span>
          </div>
          {(problem || error) && <ErrorNote>{problem ?? error}</ErrorNote>}
        </div>
        <div className="flex items-center gap-2 border-t border-rule px-5 py-3">
          {saved && (
            <Button
              variant="ghost"
              className="mr-auto text-tomate"
              onClick={async () => {
                if (await call(`/notices/${saved.id}`, "DELETE")) {
                  toast("Aviso excluído.");
                  onClose();
                }
              }}
            >
              <Trash2Icon aria-hidden /> Excluir
            </Button>
          )}
          <Button variant="outline" className={saved ? "" : "ml-auto"} onClick={onClose}>
            {saved && !notice ? "Fechar" : "Cancelar"}
          </Button>
          <Button onClick={save}>Salvar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
