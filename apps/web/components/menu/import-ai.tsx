"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ErrorNote } from "@/components/menu/bits";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { count } from "@/lib/format";
import { centsText, parseCents } from "@/lib/menu";
import {
  type AiField,
  type AiImportRow,
  type AiImportStatus,
  type AiTextField,
  applySuggestion,
  editRow,
  type ImportPreview,
  type ImportResult,
  needsReview,
  validRows,
} from "@/lib/menu-import";
import { cn } from "@/lib/utils";

const FIELD_LABEL: Record<AiTextField, string> = { category: "categoria", item: "nome", description: "descrição", size: "tamanho" };

/** P5 (foto/PDF): acompanha a leitura da IA e, no fim, abre a revisão lado a lado. */
export function AiImport({
  tenantId,
  jobId,
  onRestart,
  onDone,
}: {
  tenantId: string;
  jobId: string;
  onRestart: () => void;
  onDone: (result: ImportResult) => void;
}) {
  const { request } = useAuth();
  const job = useQuery({
    queryKey: ["menu-import-ai", tenantId, jobId],
    queryFn: () => request<AiImportStatus>(`/menu/${tenantId}/import/ai/${jobId}`),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== "reading" ? false : 2_000),
    refetchOnWindowFocus: false,
  });
  const data = job.data;

  if (job.error || data?.status === "failed") {
    const message = data?.status === "failed" ? data.message : job.error instanceof ApiError ? job.error.message : "Não foi possível acompanhar a leitura.";
    return (
      <ErrorNote
        action={
          <Button size="sm" variant="outline" onClick={onRestart}>
            Tentar de novo
          </Button>
        }
      >
        {message}
      </ErrorNote>
    );
  }
  if (data?.status === "done") return <AiReview tenantId={tenantId} status={data} onRestart={onRestart} onDone={onDone} />;

  const progress = data?.progress ?? 5;
  return (
    <section className="flex flex-col items-center gap-3 rounded-xl border border-rule bg-surface px-5 py-8 text-center">
      <div className="font-heading text-lg font-semibold">Lendo o cardápio…</div>
      <div className="text-ink-2 tabular-nums">
        {data?.fileName ?? "Arquivo enviado"}
        {data?.pages ? ` · ${count(data.pages)} ${data.pages === 1 ? "página" : "páginas"}` : ""}
      </div>
      <div
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progresso da leitura"
        className="h-2 w-[360px] max-w-full overflow-hidden rounded bg-surface-2"
      >
        <div className="h-full bg-ink transition-[width] duration-700" style={{ width: `${Math.max(progress, 5)}%` }} />
      </div>
      <div className="text-xs text-ink-3">Leva de alguns segundos a 2 minutos. Pode deixar esta tela aberta.</div>
    </section>
  );
}

function AiReview({
  tenantId,
  status,
  onRestart,
  onDone,
}: {
  tenantId: string;
  status: Extract<AiImportStatus, { status: "done" }>;
  onRestart: () => void;
  onDone: (result: ImportResult) => void;
}) {
  const { request } = useAuth();
  const [rows, setRows] = useState<AiImportRow[]>(status.rows);
  const [counts, setCounts] = useState(status.counts);
  const [onlyReview, setOnlyReview] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = useRef(false);

  // Cada edição revalida as linhas no servidor (mesmas regras do commit), sem gravar.
  useEffect(() => {
    if (!edited.current) return;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const checked = await request<ImportPreview>(`/menu/${tenantId}/import/ai/check`, { method: "POST", body: { rows } });
        const errors = new Map(checked.rows.map((row) => [row.line, row.errors]));
        setRows((current) => current.map((row) => ({ ...row, errors: errors.get(row.line) ?? row.errors })));
        setCounts(checked.counts);
        setError(null);
      } catch (failure) {
        setError(failure instanceof ApiError ? failure.message : "Não foi possível conferir as linhas.");
      } finally {
        setChecking(false);
      }
    }, 500);
    return () => clearTimeout(timer);
    // Só as edições disparam (a troca dos erros vinda do check não muda os campos).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rows.map((row) => ({ ...row, errors: null })))]);

  const update = (line: number, change: (row: AiImportRow) => AiImportRow) => {
    edited.current = true;
    setRows((current) => current.map((row) => (row.line === line ? change(row) : row)));
  };

  async function commit() {
    setError(null);
    try {
      onDone(await request<ImportResult>(`/menu/${tenantId}/import/csv/commit`, { method: "POST", body: { rows: validRows(rows) } }));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível importar. Tente de novo.");
    }
  }

  const toReview = rows.filter(needsReview);
  const shown = onlyReview ? toReview : rows;
  const low = (row: AiImportRow, field: AiField) => row.ai.lowConfidence.includes(field) && "border-warning bg-warning-lt";

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="mr-auto min-w-0">
          <div className="font-heading text-xl font-semibold tabular-nums">
            {count(counts.items)} {counts.items === 1 ? "item" : "itens"}{" "}
            <span className="text-body font-normal text-ink-2">lidos · {count(toReview.length)} para conferir</span>
          </div>
          <div className="truncate text-ink-3">{status.fileName}</div>
        </div>
        <Button variant={onlyReview ? "default" : "outline"} aria-pressed={onlyReview} onClick={() => setOnlyReview((value) => !value)}>
          Só os para conferir
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-xs text-ink-3 tabular-nums">
            Original{status.pages && status.pages > 1 ? ` · ${count(status.pages)} páginas` : ""}
          </div>
          <div className="sticky top-0 overflow-hidden rounded-lg border border-rule bg-surface-2">
            {!status.fileUrl ? (
              <div className="p-6 text-center text-ink-3">{status.fileName}</div>
            ) : status.mime === "application/pdf" ? (
              <iframe title="Cardápio enviado" src={status.fileUrl} className="h-[70vh] w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={status.fileUrl} alt="Cardápio enviado" className="max-h-[70vh] w-full object-contain" />
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-xs text-ink-3">Itens extraídos · edite direto na linha</div>
          {shown.length === 0 && <div className="rounded-lg border border-rule px-3 py-6 text-center text-ink-3">Nada para conferir.</div>}
          {shown.map((row) => (
            <div key={row.line} className={cn("flex flex-col gap-1.5 rounded-lg border border-rule p-2.5", row.errors.length > 0 && "border-tomate-line")}>
              <div className="flex gap-2">
                <input
                  aria-label="Categoria"
                  value={row.category}
                  onChange={(event) => update(row.line, (current) => editRow(current, "category", { category: event.target.value }))}
                  className={cn("h-9 w-32 shrink-0 rounded-lg border border-rule px-2 text-ink-2", low(row, "category"))}
                />
                <input
                  aria-label="Nome"
                  value={row.item}
                  onChange={(event) => update(row.line, (current) => editRow(current, "item", { item: event.target.value }))}
                  className={cn("h-9 min-w-0 flex-1 rounded-lg border border-rule px-2 font-medium", low(row, "item"))}
                />
                {row.size !== null && (
                  <input
                    aria-label="Tamanho"
                    value={row.size}
                    onChange={(event) => update(row.line, (current) => editRow(current, "size", { size: event.target.value }))}
                    className={cn("h-9 w-24 shrink-0 rounded-lg border border-rule px-2", low(row, "size"))}
                  />
                )}
                <input
                  key={`${row.line}-${row.size === null ? row.priceCents : row.sizePriceCents}`}
                  aria-label="Preço"
                  inputMode="decimal"
                  placeholder="0,00"
                  defaultValue={centsText(row.size === null ? row.priceCents : row.sizePriceCents)}
                  onBlur={(event) => {
                    const cents = parseCents(event.target.value);
                    update(row.line, (current) => editRow(current, "price", current.size === null ? { priceCents: cents } : { sizePriceCents: cents }));
                  }}
                  className={cn("h-9 w-24 shrink-0 rounded-lg border border-rule px-2 text-right tabular-nums", low(row, "price"))}
                />
              </div>
              {row.description && <div className="line-clamp-2 text-xs text-ink-3">{row.description}</div>}
              {(row.ai.note || row.ai.suggestions.length > 0) && (
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded bg-warning-lt px-2 py-1.5 text-xs text-warning-ink">
                  {row.ai.note && <span className="min-w-0 flex-1 basis-40">{row.ai.note}</span>}
                  {row.ai.suggestions.map((suggestion) => (
                    <Button
                      key={`${suggestion.field}-${suggestion.value}`}
                      size="xs"
                      variant="outline"
                      title={`Trocar a ${FIELD_LABEL[suggestion.field]}`}
                      onClick={() => update(row.line, (current) => applySuggestion(current, suggestion))}
                    >
                      Usar “{suggestion.value}”
                    </Button>
                  ))}
                </div>
              )}
              {row.errors.map((message) => (
                <div key={message} className="text-xs text-tomate-ink">
                  {message}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule pt-3">
        <span className="mr-auto text-ink-2 tabular-nums">
          Nada é salvo até você confirmar.
          {counts.invalidRows > 0 && ` ${count(counts.invalidRows)} ${counts.invalidRows === 1 ? "linha com erro fica" : "linhas com erro ficam"} de fora.`}
        </span>
        <Button variant="ghost" onClick={onRestart}>
          Descartar
        </Button>
        <Button onClick={commit} disabled={checking || counts.items === 0}>
          {checking ? "Conferindo…" : `Confirmar ${count(counts.items)} ${counts.items === 1 ? "item" : "itens"}`}
        </Button>
      </div>
    </section>
  );
}
