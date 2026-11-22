"use client";

import { formatTaxId, MENU_IMPORT_STATUS_LABEL, type PlatformMenuImportRequestDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformLoading, PlatformPage } from "@/components/platform/platform-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNow } from "@/hooks/use-now";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { count, dayTime } from "@/lib/format";
import type { ImportPreview, ImportResult, ImportRow } from "@/lib/menu-import";
import { money } from "@/lib/menu";
import { cn } from "@/lib/utils";

type IfoodPreview = ImportPreview & { warnings: string[] };

const priceText = (row: ImportRow) => {
  if (row.size) return `${row.size}: ${row.sizePriceCents === null ? "—" : money(row.sizePriceCents)}`;
  return row.priceCents === null ? "—" : money(row.priceCents);
};

/**
 * Pedidos de importação do cardápio do iFood: o restaurante pede (nome da loja e CNPJ) e a equipe lê o catálogo pela
 * Catalog API do iFood, confere e grava. Sem board no design: segue a página de Tickets de suporte.
 */
export function PlatformMenuImports() {
  const { request } = useAuth();
  const now = useNow(60_000);
  const requests = useQuery({
    queryKey: ["platform-menu-imports"],
    queryFn: () => request<PlatformMenuImportRequestDto[]>("/platform/menu-import-requests"),
  });
  const open = requests.data?.filter((r) => r.status === "OPEN") ?? [];
  const closed = requests.data?.filter((r) => r.status !== "OPEN") ?? [];

  return (
    <PlatformPage title="Importações do iFood">
      {requests.data ? (
        <>
          <section className="overflow-hidden rounded-xl border border-rule">
            <div className="border-b border-rule px-5 pt-4 pb-3.5">
              <h2 className="font-heading text-title font-semibold tabular-nums">{count(open.length)} aguardando</h2>
              <p className="mt-1 text-ink-2">Leia o cardápio da loja no iFood, confira e importe. O restaurante vê a situação na página do Cardápio.</p>
            </div>
            {open.length === 0 ? (
              <p className="px-5 py-6 text-ink-3">Nenhum pedido aguardando.</p>
            ) : (
              <ul>
                {open.map((item) => (
                  <RequestRow key={item.id} item={item} now={now} />
                ))}
              </ul>
            )}
          </section>
          {closed.length > 0 && (
            <section className="mt-4 overflow-hidden rounded-xl border border-rule">
              <h2 className="border-b border-rule px-5 pt-4 pb-3.5 font-heading text-title font-semibold">Respondidos</h2>
              <ul>
                {closed.map((item) => (
                  <li key={item.id} className="border-b border-rule-soft px-5 py-3 last:border-b-0">
                    <p className="font-medium">
                      {item.tenantName} · {item.storeName} · <span className={item.status === "DONE" ? "text-success" : "text-tomate"}>{MENU_IMPORT_STATUS_LABEL[item.status]}</span>
                    </p>
                    {item.note && <p className="mt-1 text-ink-2">{item.note}</p>}
                    <p className="mt-1 text-[12px] text-ink-3 tabular-nums">{item.resolvedAt ? dayTime(item.resolvedAt, now) : ""}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <PlatformLoading failed={requests.isError} />
      )}
    </PlatformPage>
  );
}

function RequestRow({ item, now }: { item: PlatformMenuImportRequestDto; now: number }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [channelId, setChannelId] = useState(item.ifoodStores[0]?.channelId ?? "");
  const [preview, setPreview] = useState<IfoodPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<ImportResult | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["platform-menu-imports"] });
  const fail = (failure: unknown, fallback: string) => setError(failure instanceof ApiError ? failure.message : fallback);

  const [read, reading] = usePendingAction(async () => {
    setError(null);
    try {
      setPreview(await request<IfoodPreview>(`/platform/menu-import-requests/${item.id}/ifood-preview`, { method: "POST", body: { channelId } }));
    } catch (failure) {
      fail(failure, "Não foi possível ler o cardápio do iFood.");
    }
  });

  const [commit, committing] = usePendingAction(async () => {
    if (!preview) return;
    setError(null);
    try {
      const rows = preview.rows.filter((row) => row.errors.length === 0).map((row) => ({ ...row, errors: undefined }));
      setDone(await request<ImportResult>(`/platform/menu-import-requests/${item.id}/commit`, { method: "POST", body: { rows } }));
      await refresh();
    } catch (failure) {
      fail(failure, "Não foi possível importar.");
    }
  });

  const [reject, rejecting] = usePendingAction(async () => {
    setError(null);
    try {
      await request(`/platform/menu-import-requests/${item.id}/resolve`, { method: "POST", body: { status: "REJECTED", note: note.trim() || null } });
      await refresh();
    } catch (failure) {
      fail(failure, "Não foi possível recusar o pedido.");
    }
  });

  const valid = preview?.rows.filter((row) => row.errors.length === 0).length ?? 0;
  return (
    <li className="flex flex-col gap-2.5 border-b border-rule-soft px-5 py-4 last:border-b-0">
      <div>
        <p className="font-medium">
          {item.tenantName} · {item.storeName} · <span className="tabular-nums">CNPJ {formatTaxId(item.cnpj)}</span>
        </p>
        <p className="text-[12px] text-ink-3">
          Pedido por {item.userName} · <span className="tabular-nums">{dayTime(item.createdAt, now)}</span>
        </p>
      </div>

      {item.ifoodStores.length === 0 ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          O restaurante não tem loja do iFood conectada. Peça para conectar em Configurações → Integrações → iFood, ou recuse com uma nota.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {item.ifoodStores.length > 1 && (
            <select
              aria-label="Loja do iFood"
              className="h-9 rounded-lg border border-rule bg-surface px-2.5"
              value={channelId}
              onChange={(event) => {
                setChannelId(event.target.value);
                setPreview(null);
              }}
            >
              {item.ifoodStores.map((store) => (
                <option key={store.channelId} value={store.channelId}>
                  {store.name} ({store.merchantId})
                </option>
              ))}
            </select>
          )}
          {item.ifoodStores.length === 1 && <span className="text-ink-2">Loja conectada: {item.ifoodStores[0]!.name}</span>}
          <Button variant="outline" onClick={read} loading={reading} disabled={!channelId || Boolean(done)}>
            Ler cardápio do iFood
          </Button>
        </div>
      )}

      {preview && !done && (
        <div className="flex flex-col gap-2 rounded-lg border border-rule p-3">
          <p className="tabular-nums">
            <span className="font-semibold">
              {count(valid)} de {count(preview.counts.rows)} linhas prontas
            </span>{" "}
            · {count(preview.counts.categories)} categorias novas, {count(preview.counts.items)} itens e {count(preview.counts.sizes)} tamanhos.
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning">
              {warning}
            </p>
          ))}
          <div className="max-h-80 overflow-auto rounded-md border border-rule-soft">
            <table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 bg-surface-2 text-ink-3">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Categoria</th>
                  <th className="px-2.5 py-1.5 font-medium">Item</th>
                  <th className="px-2.5 py-1.5 font-medium">Preço</th>
                  <th className="px-2.5 py-1.5 font-medium">Problema</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line} className={cn("border-t border-rule-soft", row.errors.length > 0 && "bg-tomate-lt")}>
                    <td className="px-2.5 py-1.5">{row.category}</td>
                    <td className="px-2.5 py-1.5">{row.item}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{priceText(row)}</td>
                    <td className="px-2.5 py-1.5 text-tomate">{row.errors.join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <Button onClick={commit} loading={committing} disabled={valid === 0}>
              Importar {count(valid)} {valid === 1 ? "linha" : "linhas"} no cardápio do restaurante
            </Button>
          </div>
        </div>
      )}

      {done && (
        <p role="status" className="text-success">
          Importado: {count(done.items)} itens, {count(done.sizes)} tamanhos e {count(done.categories)} categorias novas. O pedido foi concluído.
        </p>
      )}

      {!done && (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="max-w-md" placeholder="Nota ao restaurante (opcional)" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          <Button variant="ghost" onClick={reject} loading={rejecting}>
            Recusar pedido
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[12.5px] text-tomate">
          {error}
        </p>
      )}
    </li>
  );
}
