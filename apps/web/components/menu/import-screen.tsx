"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ErrorNote, PageHeader } from "@/components/menu/bits";
import { AiImport } from "@/components/menu/import-ai";
import { ImportReview } from "@/components/menu/import-review";
import { useTenantId } from "@/components/menu/use-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { count } from "@/lib/format";
import { aiFileProblem, decodeCsv, fileProblem, type ImportPreview, type ImportResult, TEMPLATE_CSV, validRows } from "@/lib/menu-import";

function downloadTemplate() {
  const blob = new Blob(["﻿", TEMPLATE_CSV], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: "modelo-cardapio.csv" });
  link.click();
  URL.revokeObjectURL(url);
}

/** P5: CSV (baixar o modelo, enviar, revisar os erros por linha, importar) ou foto/PDF lido pela IA, com revisão antes de gravar. */
export function ImportScreen() {
  const { request, session, reload } = useAuth();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const aiInput = useRef<HTMLInputElement>(null);
  const [aiJob, setAiJob] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<{ data: ImportPreview; fileName: string } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (failure: unknown) => setError(failure instanceof ApiError ? failure.message : "Não foi possível importar. Tente de novo.");

  async function readFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    const problem = fileProblem(file);
    if (problem) return setError(problem);
    try {
      const csv = decodeCsv(await file.arrayBuffer());
      const data = await request<ImportPreview>(`/menu/${tenantId}/import/csv/preview`, { method: "POST", body: { csv } });
      setPreview({ data, fileName: file.name });
    } catch (failure) {
      fail(failure);
    }
  }

  /** Envia a foto ou o PDF; a leitura segue em segundo plano (fila) e a tela acompanha pelo id. */
  async function sendToAi(file: File | undefined) {
    if (!file || sending) return;
    setError(null);
    const problem = aiFileProblem(file);
    if (problem) return setError(problem);
    const send = (token: string | null) =>
      fetch(`/api/menu/${tenantId}/import/ai`, {
        method: "POST",
        headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: file,
      });
    setSending(true);
    try {
      let response = await send(session?.accessToken ?? null);
      if (response.status === 401) response = await send((await reload())?.accessToken ?? null);
      const payload = (await response.json().catch(() => null)) as { jobId?: string; message?: unknown } | null;
      if (!response.ok || !payload?.jobId) return setError(typeof payload?.message === "string" ? payload.message : "Não foi possível enviar o arquivo. Tente de novo.");
      setAiJob(payload.jobId);
    } catch {
      setError("Não foi possível enviar o arquivo. Tente de novo.");
    } finally {
      setSending(false);
      if (aiInput.current) aiInput.current.value = "";
    }
  }

  async function aiDone(done: ImportResult) {
    setResult(done);
    setAiJob(null);
    await queryClient.invalidateQueries({ queryKey: ["menu", tenantId] });
  }

  async function commit() {
    if (!preview) return;
    setError(null);
    try {
      setResult(await request<ImportResult>(`/menu/${tenantId}/import/csv/commit`, { method: "POST", body: { rows: validRows(preview.data.rows) } }));
      await queryClient.invalidateQueries({ queryKey: ["menu", tenantId] });
    } catch (failure) {
      fail(failure);
    }
  }

  const header = (
    <PageHeader
      crumb={
        <>
          <Link href="/cardapio" className="hover:underline">
            Cardápio
          </Link>{" "}
          / Importar
        </>
      }
      title="Importar cardápio"
    />
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-10">
      {header}
      {error && <ErrorNote>{error}</ErrorNote>}

      {result ? (
        <section className="flex flex-col gap-3 rounded-xl border border-rule bg-surface p-6">
          <h2 className="font-heading text-xl font-semibold">Cardápio importado</h2>
          <p className="text-ink-2 tabular-nums">
            {count(result.items)} {result.items === 1 ? "item criado" : "itens criados"}, {count(result.categories)}{" "}
            {result.categories === 1 ? "categoria nova" : "categorias novas"} e {count(result.sizes)} {result.sizes === 1 ? "tamanho" : "tamanhos"}.
          </p>
          <Link href="/cardapio" className={buttonVariants({ className: "self-start" })}>
            Ver o cardápio
          </Link>
        </section>
      ) : aiJob && tenantId ? (
        <AiImport tenantId={tenantId} jobId={aiJob} onRestart={() => setAiJob(null)} onDone={aiDone} />
      ) : preview ? (
        <>
          <ImportReview preview={preview.data} fileName={preview.fileName} onRestart={() => setPreview(null)} onTemplate={downloadTemplate} />
          <div className="flex items-center gap-3">
            <Button onClick={commit} disabled={preview.data.counts.validRows === 0}>
              Importar {count(preview.data.counts.validRows)} de {count(preview.data.counts.rows)}
            </Button>
            <Link href="/cardapio" className={buttonVariants({ variant: "ghost" })}>
              Cancelar
            </Link>
          </div>
        </>
      ) : (
        <section className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          <div className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-5">
            <div className="text-sm font-semibold">Planilha (CSV)</div>
            <ol className="flex-1 list-decimal pl-4 text-ink-2">
              <li>Baixe o modelo e preencha uma linha por item (ou por tamanho).</li>
              <li>Salve como CSV e envie aqui.</li>
              <li>Você revisa os erros por linha antes de importar.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={downloadTemplate}>
                Baixar o modelo
              </Button>
              <input ref={input} type="file" accept=".csv,.txt,text/csv" hidden onChange={(event) => void readFile(event.target.files?.[0])} />
              <Button onClick={() => input.current?.click()}>Enviar arquivo</Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-5">
            <div className="text-sm font-semibold">Foto ou PDF do cardápio</div>
            <p className="flex-1 text-ink-2">A IA lê o cardápio impresso e monta os itens. Nada salva sem você confirmar.</p>
            <p className="text-xs text-ink-3">Foto JPG, PNG ou WEBP de até 5 MB, ou PDF de até 10 MB e 10 páginas.</p>
            <input
              ref={aiInput}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              hidden
              onChange={(event) => void sendToAi(event.target.files?.[0])}
            />
            <Button onClick={() => aiInput.current?.click()} loading={sending} disabled={sending} className="self-start">
              Enviar foto ou PDF
            </Button>
          </div>
        </section>
      )}
    </main>
  );
}
