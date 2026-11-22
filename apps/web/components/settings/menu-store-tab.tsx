"use client";

import type { MenuStoreSettings } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ImageCropDialog } from "@/components/common/image-crop-dialog";
import { photoProblem } from "@/components/menu/use-menu";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Card, CardBody, CardFooter, Eyebrow, TEXTAREA } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { CROP_PRESETS } from "@/lib/image-compress";
import type { MenuTree } from "@/lib/menu";
import { formToPayload, publicMenuUrl, type StoreForm, type StoreResponse, storeToForm } from "@/lib/menu-store";

/** Página "Cardápio e entrega" (C1): link público, endereço, entrega, agendamento, marca e contato. */
export function MenuStoreTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const query = useQuery({ queryKey: ["menu-store", tenant.id], queryFn: () => request<StoreResponse>(`/menu/${tenant.id}/store`), retry: false });
  if (query.error instanceof ApiError && query.error.status === 403) {
    return <p className="text-ink-3">O módulo Cardápio não está ativo neste restaurante.</p>;
  }
  return query.data ? <MenuStoreForm key={tenant.id} tenantId={tenant.id} data={query.data} /> : <TabLoading failed={query.isError} />;
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function MenuStoreForm({ tenantId, data }: { tenantId: string; data: StoreResponse }) {
  const { request, session, reload } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [store, setStore] = useState<MenuStoreSettings>(data.store);
  const [form, setForm] = useState<StoreForm>(() => storeToForm(data.store, data.accentDefault));
  const [failure, setFailure] = useState<string | null>(null);
  const set = <K extends keyof StoreForm>(key: K, value: StoreForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const link = publicMenuUrl(typeof window === "undefined" ? "" : window.location.origin, data.slug);

  const [copy] = usePendingAction(async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copiado");
    } catch {
      toast("Não foi possível copiar. Selecione o link e copie.");
    }
  });

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const result = formToPayload(form, store);
    if (!result.ok) return setFailure(result.error);
    try {
      const updated = await request<StoreResponse>(`/menu/${tenantId}/store`, { method: "PUT", body: result.body });
      setStore(updated.store);
      setForm(storeToForm(updated.store, updated.accentDefault));
      queryClient.setQueryData(["menu-store", tenantId], updated);
      toast("Cardápio e entrega salvos");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  /** Envia a logo ou a capa (`PUT /menu/:tenantId/store/logo|cover`, arquivo no corpo com o tipo da imagem). */
  async function upload(kind: "logo" | "cover", file: File) {
    setFailure(null);
    const problem = photoProblem(file);
    if (problem) return setFailure(problem);
    const send = (token: string | null) =>
      fetch(`/api/menu/${tenantId}/store/${kind}`, {
        method: "PUT",
        headers: { "Content-Type": file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: file,
      });
    try {
      let response = await send(session?.accessToken ?? null);
      if (response.status === 401) response = await send((await reload())?.accessToken ?? null);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
        return setFailure(typeof payload?.message === "string" ? payload.message : `${file.name} não foi enviada: use JPG, PNG ou WEBP de até 1 MB.`);
      }
      const updated = (await response.json()) as StoreResponse;
      setStore((current) => ({ ...current, logoUrl: updated.store.logoUrl, coverUrl: updated.store.coverUrl }));
      queryClient.setQueryData(["menu-store", tenantId], updated);
      toast(kind === "logo" ? "Logo atualizada" : "Capa atualizada");
    } catch {
      setFailure("Não foi possível enviar a imagem. Confira a conexão e tente de novo.");
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Card title="Cardápio público" aside={<StatePill on label={["No ar", "Fora do ar"]} />}>
        <CardBody className="flex items-center gap-2">
          <Input readOnly value={link} aria-label="Link público do cardápio" onFocus={(event) => event.currentTarget.select()} />
          <Button type="button" variant="outline" onClick={copy}>
            <CopyIcon aria-hidden /> Copiar link
          </Button>
        </CardBody>
      </Card>

      <Card title="Loja" description="O endereço aparece em “Sobre a loja” e é a origem do cálculo da entrega.">
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-6 gap-3">
            <Field label="Rua" className="col-span-3">
              <Input value={form.street} maxLength={120} onChange={(e) => set("street", e.target.value)} />
            </Field>
            <Field label="Número" className="col-span-1">
              <Input value={form.number} maxLength={20} onChange={(e) => set("number", e.target.value)} />
            </Field>
            <Field label="Bairro" className="col-span-2">
              <Input value={form.district} maxLength={80} onChange={(e) => set("district", e.target.value)} />
            </Field>
            <Field label="Cidade" className="col-span-3">
              <Input value={form.city} maxLength={80} onChange={(e) => set("city", e.target.value)} />
            </Field>
            <Field label="UF" className="col-span-1">
              <Input value={form.state} maxLength={2} onChange={(e) => set("state", e.target.value)} />
            </Field>
            <Field label="CEP" className="col-span-2">
              <Input value={form.zip} maxLength={9} onChange={(e) => set("zip", e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <Field label="Tempo de preparo (min)" className="w-48">
              <Input inputMode="numeric" value={form.prepMinutes} onChange={(e) => set("prepMinutes", e.target.value)} />
            </Field>
            <label className="flex h-9 items-center gap-3 text-[13px] font-medium">
              <input type="checkbox" className="size-4 accent-ink" checked={form.pickupEnabled} onChange={(e) => set("pickupEnabled", e.target.checked)} />
              Aceitar retirada na loja <span className="font-normal text-ink-3">· grátis, pronto no tempo de preparo</span>
            </label>
          </div>
        </CardBody>
      </Card>

      <Card
        title="Áreas de entrega"
        aside={
          <div className="inline-flex overflow-hidden rounded-lg border border-rule" role="group" aria-label="Como cobrar a entrega">
            {(["BY_DISTRICT", "BY_RADIUS"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={form.mode === mode}
                onClick={() => set("mode", mode)}
                className={form.mode === mode ? "h-8 bg-ink px-3 text-[12.5px] font-semibold text-paper" : "h-8 bg-surface px-3 text-[12.5px] text-ink-2"}
              >
                {mode === "BY_DISTRICT" ? "Por bairro" : "Por raio"}
              </button>
            ))}
          </div>
        }
      >
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_8rem_2.5rem] gap-x-3 border-b border-rule pb-1.5 text-[12px] text-ink-3">
            <span>{form.mode === "BY_DISTRICT" ? "Bairro" : "Até (km)"}</span>
            <span>Taxa</span>
            <span />
          </div>
          {form.mode === "BY_DISTRICT"
            ? form.districts.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_2.5rem] items-center gap-x-3">
                  <Input
                    placeholder="Bairro"
                    aria-label="Bairro"
                    value={row.district}
                    maxLength={80}
                    onChange={(e) => set("districts", form.districts.map((r, j) => (j === i ? { ...r, district: e.target.value } : r)))}
                  />
                  <Input
                    inputMode="decimal"
                    placeholder="R$ 0,00"
                    aria-label={`Taxa de ${row.district || "bairro"} em reais`}
                    value={row.fee}
                    onChange={(e) => set("districts", form.districts.map((r, j) => (j === i ? { ...r, fee: e.target.value } : r)))}
                  />
                  <Button type="button" variant="ghost" size="sm" aria-label="Remover bairro" onClick={() => set("districts", form.districts.filter((_, j) => j !== i))}>
                    <XIcon aria-hidden />
                  </Button>
                </div>
              ))
            : form.radii.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_2.5rem] items-center gap-x-3">
                  <Input
                    inputMode="decimal"
                    placeholder="km"
                    aria-label="Distância máxima em km"
                    value={row.maxKm}
                    onChange={(e) => set("radii", form.radii.map((r, j) => (j === i ? { ...r, maxKm: e.target.value } : r)))}
                  />
                  <Input
                    inputMode="decimal"
                    placeholder="R$ 0,00"
                    aria-label="Taxa em reais"
                    value={row.fee}
                    onChange={(e) => set("radii", form.radii.map((r, j) => (j === i ? { ...r, fee: e.target.value } : r)))}
                  />
                  <Button type="button" variant="ghost" size="sm" aria-label="Remover raio" onClick={() => set("radii", form.radii.filter((_, j) => j !== i))}>
                    <XIcon aria-hidden />
                  </Button>
                </div>
              ))}
          <div>
            <button
              type="button"
              className="h-8 rounded-md border border-dashed border-tag-line px-3 text-[12.5px] font-medium"
              onClick={() =>
                form.mode === "BY_DISTRICT" ? set("districts", [...form.districts, { district: "", fee: "" }]) : set("radii", [...form.radii, { maxKm: "", fee: "" }])
              }
            >
              <PlusIcon className="mr-1 inline size-3.5" aria-hidden />
              {form.mode === "BY_DISTRICT" ? "Bairro" : "Raio"}
            </button>
          </div>
          <div className="grid grid-cols-4 gap-3 border-t border-rule pt-3">
            <Field label="Pedido mínimo (R$)">
              <Input inputMode="decimal" value={form.minOrder} onChange={(e) => set("minOrder", e.target.value)} />
            </Field>
            <Field label="Entrega grátis a partir de (R$)">
              <Input inputMode="decimal" placeholder="Nunca" value={form.freeFrom} onChange={(e) => set("freeFrom", e.target.value)} />
            </Field>
            <Field label="Prazo de (min)">
              <Input inputMode="numeric" value={form.deliveryMin} onChange={(e) => set("deliveryMin", e.target.value)} />
            </Field>
            <Field label="Prazo até (min)">
              <Input inputMode="numeric" value={form.deliveryMax} onChange={(e) => set("deliveryMax", e.target.value)} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 items-start gap-5">
        <Card
          title="Agendamento"
          aside={<StatePill on={form.schedulingEnabled} label={["Ligado", "Desligado"]} onToggle={() => set("schedulingEnabled", !form.schedulingEnabled)} />}
        >
          <CardBody className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Antecedência mínima (min)">
                <Input inputMode="numeric" disabled={!form.schedulingEnabled} value={form.minLeadMinutes} onChange={(e) => set("minLeadMinutes", e.target.value)} />
              </Field>
              <Field label="Faixas de (min)">
                <Input inputMode="numeric" disabled={!form.schedulingEnabled} value={form.slotMinutes} onChange={(e) => set("slotMinutes", e.target.value)} />
              </Field>
            </div>
            <p className="m-0 text-[12px] text-ink-3">Com a loja fechada, o cliente agenda para depois que abrir.</p>
          </CardBody>
        </Card>

        <Card title="Vitrine de promoções">
          <CardBody className="flex flex-col gap-3">
            <ShowcasePicker tenantId={tenantId} selected={form.showcaseItemIds} onChange={(ids) => set("showcaseItemIds", ids)} />
            <Field label="Mostrar para o mesmo cliente no máximo 1 vez a cada (horas)">
              <Input inputMode="numeric" className="max-w-32" value={form.showcaseHours} onChange={(e) => set("showcaseHours", e.target.value)} />
            </Field>
          </CardBody>
        </Card>
      </div>

      <Card title="Marca" description="Logo, capa e cor de destaque da página pública. Você escolhe o enquadramento e a imagem é comprimida para até 1 MB.">
        <CardBody className="grid grid-cols-3 gap-4">
          <ImagePick label="Logo" preset="logo" url={store.logoUrl} onPick={(file) => upload("logo", file)} />
          <ImagePick label="Capa" preset="cover" url={store.coverUrl} onPick={(file) => upload("cover", file)} />
          <Field label="Cor de destaque">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Escolher a cor"
                value={/^#[0-9a-fA-F]{6}$/.test(form.accentColor) ? form.accentColor : data.accentDefault}
                onChange={(e) => set("accentColor", e.target.value)}
                className="h-9 w-10 rounded-lg border border-input bg-surface p-1"
              />
              <Input value={form.accentColor} maxLength={7} onChange={(e) => set("accentColor", e.target.value)} />
            </div>
          </Field>
        </CardBody>
      </Card>

      <Card title="Contato" description="Aparece em “Sobre a loja”.">
        <CardBody className="grid grid-cols-2 gap-3">
          <Field label="Telefone">
            <Input value={form.phone} maxLength={20} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label="CNPJ">
            <Input value={form.cnpj} maxLength={18} onChange={(e) => set("cnpj", e.target.value)} />
          </Field>
          <Field label="Sobre o restaurante" className="col-span-2">
            <textarea className={TEXTAREA} rows={3} maxLength={500} value={form.about} onChange={(e) => set("about", e.target.value)} />
          </Field>
        </CardBody>
        <CardFooter error={failure}>
          <Button type="submit" loading={saving}>
            Salvar
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

/** Imagem atual e botão de troca; o envio acontece assim que o arquivo é escolhido. */
function ImagePick({ label, preset, url, onPick }: { label: string; preset: "logo" | "cover"; url?: string; onPick: (file: File) => Promise<unknown> }) {
  const input = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  return (
    <Field label={label}>
      <div className="flex h-20 items-center justify-center overflow-hidden rounded-lg border border-dashed border-rule bg-surface-2 text-ink-3">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- pré-visualização da imagem enviada.
          <img src={url} alt="" className="size-full object-cover" />
        ) : (
          "Sem imagem"
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) setCropping(file);
        }}
      />
      <ImageCropDialog
        file={cropping}
        aspect={CROP_PRESETS[preset].aspect}
        maxWidth={CROP_PRESETS[preset].maxWidth}
        title={preset === "logo" ? "Enquadrar a logo" : "Enquadrar a capa"}
        onCancel={() => setCropping(null)}
        onConfirm={async (cropped) => {
          await onPick(cropped);
          setCropping(null);
        }}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
        {url ? "Trocar" : "Enviar"}
      </Button>
    </Field>
  );
}

/** Itens da vitrine (W3): marque os itens, na ordem do cardápio. Até 50. */
function ShowcasePicker({ tenantId, selected, onChange }: { tenantId: string; selected: string[]; onChange: (ids: string[]) => void }) {
  const { request } = useAuth();
  const menu = useQuery({ queryKey: ["menu", tenantId], queryFn: () => request<MenuTree>(`/menu/${tenantId}`) });
  if (!menu.data) return <p className="text-ink-3">{menu.isError ? "Não foi possível carregar os itens do cardápio." : "Carregando os itens…"}</p>;
  const categories = menu.data.categories.filter((category) => category.items.some((item) => item.active));
  if (!categories.length) return <p className="text-ink-3">Cadastre itens no Cardápio para montar a vitrine.</p>;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(0, 50));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ink-2 tabular-nums">{selected.length === 0 ? "Nenhum item: a vitrine não aparece." : `${selected.length} ${selected.length === 1 ? "item" : "itens"} na vitrine.`}</p>
      <div className="grid max-h-72 grid-cols-2 gap-x-4 gap-y-1 overflow-auto rounded-lg border border-rule p-3">
        {categories.map((category) => (
          <div key={category.id} className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-1">
            <Eyebrow className="col-span-2 mt-1">{category.name}</Eyebrow>
            {category.items
              .filter((item) => item.active)
              .map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" className="size-4 accent-ink" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />
                  <span className={item.soldOut ? "text-ink-3" : undefined}>
                    {item.name}
                    {item.soldOut && " (esgotado)"}
                  </span>
                </label>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pílula de estado do board (verde ligado, cinza desligado) com o estado escrito; com `onToggle` vira o interruptor. */
function StatePill({ on, label, onToggle }: { on: boolean; label: [string, string]; onToggle?: () => void }) {
  const className = on
    ? "inline-flex h-7 items-center gap-1.5 rounded-full border border-success-line bg-success-lt py-0 pr-2.5 pl-[5px] text-xs font-semibold text-success-ink"
    : "inline-flex h-7 items-center gap-1.5 rounded-full border border-rule bg-surface-2 py-0 pr-2.5 pl-[5px] text-xs font-semibold text-ink-3";
  const dot = <span className={on ? "size-[18px] rounded-full bg-success" : "size-[18px] rounded-full bg-ink-3"} aria-hidden />;
  if (!onToggle) {
    return (
      <span className={className}>
        {dot}
        {on ? label[0] : label[1]}
      </span>
    );
  }
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle} className={className}>
      {dot}
      {on ? label[0] : label[1]}
    </button>
  );
}
