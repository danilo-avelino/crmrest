"use client";

import type { BlockedZone, MenuStoreSettings } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { BanIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { BLOCK, ErrorNote, loadError, MenuPage, PageHeader, Toggle, WarnNote } from "@/components/menu/bits";
import { useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { centsText, parseCents } from "@/lib/menu";
import { plural } from "@/lib/menu-backstage";
import type { StoreResponse } from "@/lib/menu-store";
import { cn } from "@/lib/utils";

/** A cobrança por área desenhada saiu da tela: a loja que ainda a usa abre em "Por raio" com um aviso. */
type Mode = "BY_DISTRICT" | "BY_RADIUS";
type LatLng = { lat: number; lng: number };
/** Faixas por bairro e por raio, editadas aqui em texto (como a tela Cardápio e entrega). */
type Rows = { districts: { district: string; fee: string }[]; radii: { maxKm: string; fee: string }[] };
/** O polígono desenhado é sempre uma zona sem entrega. */
type Drawing = { type: "polygon"; points: LatLng[] } | { type: "store" } | null;

/** Cor das zonas sem entrega no mapa (tomate). */
const BLOCK_COLOR = "#C4341A";
const AREA_COLORS = ["#2D7D46", "#B45309", "#1A1814", "#C4341A", "#7C3AED", "#2563EB"];
/** Centro do Brasil, quando a loja ainda não tem localização. */
const BRAZIL: LatLng = { lat: -15.78, lng: -47.93 };

/** De onde veio o ponto da loja, do mais preciso ao menos. */
type GeoSource = "number" | "street" | "cep" | "district" | "city";
type Geo = { at: LatLng; source: GeoSource };
const GEO_TEXT: Record<GeoSource, string> = {
  number: "pelo endereço com número",
  street: "pela rua (sem achar o número)",
  cep: "pelo CEP",
  district: "pelo bairro: confira o pino",
  city: "só pela cidade: confira o pino",
};

/** Busca no Nominatim (OpenStreetMap, o mesmo do mapa): o primeiro resultado e o place_rank (30 = casa, 26 = rua). */
async function nominatim(params: Record<string, string>): Promise<{ at: LatLng; rank: number } | null> {
  const query = new URLSearchParams({ ...params, format: "jsonv2", limit: "1", countrycodes: "br" });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const [hit] = (await res.json()) as { lat: string; lon: string; place_rank: number }[];
    return hit ? { at: { lat: Number(hit.lat), lng: Number(hit.lon) }, rank: hit.place_rank } : null;
  } catch {
    return null;
  }
}

/**
 * Lat/lng da loja pelo CEP e pelo endereço cadastrados, ficando com o mais preciso: número > rua > CEP > bairro > cidade.
 * O CEP também completa rua, bairro e cidade que faltem no cadastro. null: nada achado.
 */
async function geocodeStore(saved: MenuStoreSettings["address"], storeCity: string): Promise<Geo | null> {
  const address = { ...saved, city: storeCity || saved.city };
  const zip = address.zip.replace(/\D/g, "");
  // O CEP diz a rua certa (a coordenada que ele traz às vezes é só o centro da cidade, por isso não é usada).
  let cepStreet = "";
  if (zip.length === 8) {
    try {
      const res = await fetch(`https://brasilapi.com.br/api/cep/v2/${zip}`);
      if (res.ok) {
        const cep = (await res.json()) as { street?: string; neighborhood?: string; city?: string; state?: string };
        cepStreet = cep.street ?? "";
        address.district ||= cep.neighborhood ?? "";
        address.city ||= cep.city ?? "";
        address.state ||= cep.state ?? "";
      }
    } catch {
      // sem o CEP, segue pelo endereço
    }
  }
  const place = { city: address.city, state: address.state, country: "Brasil" };
  const streets = [...new Set([address.street.trim(), cepStreet.trim()].filter(Boolean))];
  let road: { at: LatLng; rank: number; fromCep: boolean } | null = null;
  for (const street of address.city ? streets : []) {
    const fromCep = street !== address.street.trim();
    if (address.number.trim()) {
      const exact = await nominatim({ ...place, street: `${address.number.trim()} ${street}` });
      if (exact && exact.rank >= 28) return { at: exact.at, source: "number" };
      if (!road && exact && exact.rank >= 26) road = { ...exact, fromCep };
    }
    if (!road) {
      const hit = await nominatim({ ...place, street });
      if (hit && hit.rank >= 26) road = { ...hit, fromCep };
    }
  }
  if (road) return { at: road.at, source: road.fromCep ? "cep" : "street" };
  if (zip.length === 8) {
    const byZip = await nominatim({ postalcode: `${zip.slice(0, 5)}-${zip.slice(5)}`, country: "Brasil" });
    if (byZip && byZip.rank >= 21) return { at: byZip.at, source: "cep" };
  }
  if (address.district && address.city) {
    const district = await nominatim({ q: `${address.district}, ${address.city}, ${address.state}` });
    if (district) return { at: district.at, source: "district" };
  }
  if (address.city) {
    const city = await nominatim(place);
    if (city) return { at: city.at, source: "city" };
  }
  return null;
}

const NO_LOCATION = "Não achamos a loja no mapa pelo CEP nem pelo endereço. Confira o CEP e o endereço em Configurações → Cardápio e entrega: as distâncias são medidas a partir da loja.";

const newId = () => Math.random().toString(36).slice(2, 10);
const kmText = (km: number) => (Number.isInteger(km) ? String(km) : km.toFixed(1).replace(".", ","));

/** N6: onde o cardápio entrega, com a taxa por bairro ou por raio e as zonas sem entrega desenhadas no mapa. */
export function AreasPage() {
  const { request, session } = useAuth();
  const tenantId = useTenantId();
  const storeName = session?.context?.tenants.find((t) => t.id === tenantId)?.name ?? "Loja";
  const queryClient = useQueryClient();
  const toast = useToast();
  const store = useQuery({ queryKey: ["menu-store", tenantId], queryFn: () => request<StoreResponse>(`/menu/${tenantId}/store`), enabled: Boolean(tenantId), retry: false });

  const [mode, setMode] = useState<Mode>("BY_RADIUS");
  /** A loja ainda cobra por área desenhada: vale até salvar por bairro ou raio. */
  const [legacyAreas, setLegacyAreas] = useState(false);
  const [blocked, setBlocked] = useState<BlockedZone[]>([]);
  const [rows, setRows] = useState<Rows>({ districts: [], radii: [] });
  const [location, setLocation] = useState<LatLng | null>(null);
  const [pickup, setPickup] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [drawing, setDrawing] = useState<Drawing>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [geoDone, setGeoDone] = useState(false);
  const [geoSource, setGeoSource] = useState<GeoSource | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!store.data || loaded.current) return;
    loaded.current = true;
    const s = store.data.store;
    setMode(s.delivery.mode === "BY_AREA" ? "BY_RADIUS" : s.delivery.mode);
    setLegacyAreas(s.delivery.mode === "BY_AREA");
    setBlocked(s.blockedZones ?? []);
    setRows({
      districts: s.delivery.mode === "BY_DISTRICT" ? s.delivery.districts.map((d) => ({ district: d.district, fee: centsText(d.feeCents) })) : [],
      radii: s.delivery.mode === "BY_RADIUS" ? s.delivery.radii.map((r) => ({ maxKm: kmText(r.maxKm), fee: centsText(r.feeCents) })) : [],
    });
    const saved = s.address.lat != null && s.address.lng != null ? { lat: s.address.lat, lng: s.address.lng } : null;
    setLocation(saved);
    setPickup(s.pickupEnabled);
    if (saved) return;
    // Loja sem localização: acha pelo CEP e pelo endereço cadastrados; o gestor confere o pino e salva.
    void geocodeStore(s.address, s.city ?? "").then((geo) => {
      setGeoDone(true);
      if (!geo) return;
      setLocation((current) => current ?? geo.at);
      setGeoSource(geo.source);
      setDirty(true);
    });
  }, [store.data]);

  const touch = () => setDirty(true);

  async function save() {
    setProblem(null);
    if (!store.data) return;
    const base = store.data.store;
    let delivery: MenuStoreSettings["delivery"];
    if (mode === "BY_DISTRICT") {
      const districts = [];
      for (const r of rows.districts) {
        const fee = parseCents(r.fee);
        if (!r.district.trim() || fee === null) return setProblem("Cada bairro precisa de nome e taxa em R$.");
        districts.push({ district: r.district.trim(), feeCents: fee });
      }
      delivery = { mode, districts };
    } else {
      const radii = [];
      for (const r of rows.radii) {
        const maxKm = Number(r.maxKm.replace(",", "."));
        const fee = parseCents(r.fee);
        if (!(maxKm > 0 && maxKm <= 200) || fee === null) return setProblem("Cada raio precisa de km (até 200) e taxa em R$.");
        radii.push({ maxKm, feeCents: fee });
      }
      if (radii.length && !location) return setProblem(NO_LOCATION);
      delivery = { mode, radii };
    }
    // Logo, capa e recebedor do Pix não vão no corpo (mudam por outras rotas).
    const rest: Partial<MenuStoreSettings> = { ...base };
    delete rest.logoUrl;
    delete rest.coverUrl;
    delete rest.pixRecipientId;
    const address = { ...base.address, ...(location ? { lat: location.lat, lng: location.lng } : {}) };
    try {
      const updated = await request<StoreResponse>(`/menu/${tenantId}/store`, { method: "PUT", body: { ...rest, address, pickupEnabled: pickup, delivery, blockedZones: blocked } });
      queryClient.setQueryData(["menu-store", tenantId], updated);
      setDirty(false);
      setLegacyAreas(false);
      toast("Áreas de entrega salvas.");
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Não foi possível salvar. Tente de novo.");
    }
  }

  const header = (
    <PageHeader title="Áreas de entrega" description="Onde o cardápio aceita entrega, com taxa e prazo de cada área.">
      <Link href="/cardapio/entrega" className="text-[13px] font-medium underline">
        Taxa mínima e pedido mínimo
      </Link>
      <Button disabled={!dirty || !store.data} onClick={() => save()}>
        Salvar
      </Button>
    </PageHeader>
  );

  if (store.isPending) {
    return (
      <MenuPage>
        {header}
        <div className={cn(BLOCK, "p-8 text-center text-ink-3")} aria-busy>
          Carregando as áreas…
        </div>
      </MenuPage>
    );
  }
  if (store.isError) {
    const failure = loadError(store.error);
    return (
      <MenuPage>
        {header}
        <ErrorNote action={!failure.forbidden && <Button size="sm" variant="outline" onClick={() => store.refetch()}>Tentar de novo</Button>}>
          {failure.forbidden ? failure.text : "Não foi possível carregar as áreas. As taxas que já valem continuam no cardápio."}
        </ErrorNote>
      </MenuPage>
    );
  }


  const savedAddress = store.data.store.address;
  const locating = !location && !geoDone && (savedAddress.lat == null || savedAddress.lng == null);
  const count = mode === "BY_DISTRICT" ? rows.districts.length : rows.radii.length;
  return (
    <MenuPage>
      {header}
      {problem && <ErrorNote>{problem}</ErrorNote>}
      {legacyAreas && <WarnNote>Esta loja ainda cobra por área desenhada, que saiu do Dish Desk. As áreas continuam valendo até você escolher bairro ou raio e salvar.</WarnNote>}
      <div className="flex items-start gap-4">
        <AreasMap
          mode={mode}
          blocked={blocked}
          radii={rows.radii}
          location={location}
          locating={locating}
          geoSource={geoSource}
          storeName={storeName}
          drawing={drawing}
          setDrawing={setDrawing}
          onLocation={(at) => {
            setLocation(at);
            touch();
          }}
          onCreateBlock={(points) => {
            setBlocked((list) => [...list, { id: newId(), name: `Zona sem entrega ${list.length + 1}`, points }]);
            touch();
          }}
        />
        <aside className={cn(BLOCK, "flex w-[320px] shrink-0 flex-col")} aria-label="Áreas">
          <div className="flex flex-col gap-3 border-b border-rule px-4 py-4">
            <p className="font-heading text-[24px] font-bold">{plural(count, mode === "BY_DISTRICT" ? "bairro" : "raio", mode === "BY_DISTRICT" ? "bairros" : "raios")}</p>
            <p className="text-[13px] font-semibold">Como cobrar a entrega</p>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Como cobrar a entrega">
              {(["BY_DISTRICT", "BY_RADIUS"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => {
                    setMode(m);
                    setDrawing(null);
                    touch();
                  }}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    mode === m ? "border-ink bg-surface-2" : "border-rule bg-surface hover:border-ink-3",
                  )}
                >
                  <span
                    className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2", mode === m ? "border-ink" : "border-rule")}
                    aria-hidden
                  >
                    {mode === m && <span className="size-2 rounded-full bg-ink" />}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className={cn("text-[13px]", mode === m ? "font-semibold text-ink" : "font-medium text-ink-2")}>
                      {m === "BY_DISTRICT" ? "Por bairro" : "Por raio"}
                    </span>
                    <span className="text-[12px] text-ink-3">
                      {m === "BY_DISTRICT"
                        ? "Taxa por bairro, como o cliente escreve no endereço."
                        : "Taxa até cada distância da loja, em linha reta. Vale a menor faixa que cobre o endereço."}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[12px] text-ink-3">Só vale a forma escolhida: ao salvar, a outra deixa de valer.</p>
          </div>
          <SimpleRows
            mode={mode}
            rows={rows}
            onChange={(next) => {
              setRows(next);
              touch();
            }}
          />
          <div className="flex flex-col gap-2 border-t border-rule px-4 py-3">
            <p className="text-[13px] font-semibold">Zonas sem entrega</p>
            <p className="text-[12.5px] text-ink-2">Endereço dentro delas não recebe pedido, mesmo dentro de uma área. Use &ldquo;Zona sem entrega&rdquo; no mapa.</p>
            {blocked.map((zone) => (
              <div key={zone.id} className="flex items-center gap-2">
                <span className="size-4 shrink-0 rounded-[3px] border-2 border-dashed border-tomate" aria-hidden />
                <Input
                  aria-label="Nome da zona sem entrega"
                  value={zone.name}
                  maxLength={60}
                  onChange={(e) => {
                    setBlocked((list) => list.map((z) => (z.id === zone.id ? { ...z, name: e.target.value } : z)));
                    touch();
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Excluir ${zone.name}`}
                  onClick={() => {
                    setBlocked((list) => list.filter((z) => z.id !== zone.id));
                    touch();
                  }}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-auto flex flex-col gap-1.5 border-t border-rule px-4 py-3">
            <p className="text-[13px] font-semibold">Fora das áreas</p>
            <p className="text-[12.5px] text-ink-2">O cliente vê &ldquo;Não entregamos neste endereço&rdquo;.</p>
            <span className="flex items-center gap-2.5 text-[13px]">
              <Toggle
                on={pickup}
                label="Oferecer retirada na loja"
                onToggle={() => {
                  setPickup(!pickup);
                  touch();
                }}
              />
              Oferecer retirada na loja
            </span>
          </div>
        </aside>
      </div>
    </MenuPage>
  );
}

function SimpleRows({ mode, rows, onChange }: { mode: Mode; rows: Rows; onChange: (r: Rows) => void }) {
  const district = mode === "BY_DISTRICT";
  const list = district ? rows.districts : rows.radii;
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="grid grid-cols-[1fr_6rem_2rem] gap-2 text-[12px] text-ink-3">
        <span>{district ? "Bairro" : "Até (km)"}</span>
        <span>Taxa</span>
        <span />
      </div>
      {list.map((row, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_2rem] items-center gap-2">
          {district ? (
            <Input
              aria-label="Bairro"
              value={rows.districts[i]!.district}
              onChange={(e) => onChange({ ...rows, districts: rows.districts.map((r, j) => (j === i ? { ...r, district: e.target.value } : r)) })}
            />
          ) : (
            <Input aria-label="Distância máxima em km" inputMode="decimal" value={rows.radii[i]!.maxKm} onChange={(e) => onChange({ ...rows, radii: rows.radii.map((r, j) => (j === i ? { ...r, maxKm: e.target.value } : r)) })} />
          )}
          <Input
            aria-label="Taxa em reais"
            inputMode="decimal"
            value={row.fee}
            onChange={(e) =>
              district
                ? onChange({ ...rows, districts: rows.districts.map((r, j) => (j === i ? { ...r, fee: e.target.value } : r)) })
                : onChange({ ...rows, radii: rows.radii.map((r, j) => (j === i ? { ...r, fee: e.target.value } : r)) })
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remover"
            onClick={() => (district ? onChange({ ...rows, districts: rows.districts.filter((_, j) => j !== i) }) : onChange({ ...rows, radii: rows.radii.filter((_, j) => j !== i) }))}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      <button
        type="button"
        className="h-8 self-start rounded-md border border-dashed border-tag-line px-3 text-[12.5px] font-medium"
        onClick={() => (district ? onChange({ ...rows, districts: [...rows.districts, { district: "", fee: "" }] }) : onChange({ ...rows, radii: [...rows.radii, { maxKm: "", fee: "" }] }))}
      >
        <PlusIcon className="mr-1 inline size-3.5" aria-hidden />
        {district ? "Bairro" : "Raio"}
      </button>
    </div>
  );
}

/** O mapa (Leaflet + OpenStreetMap): a loja, os raios e o desenho das zonas sem entrega. */
function AreasMap({
  mode,
  blocked,
  radii,
  location,
  locating,
  geoSource,
  storeName,
  drawing,
  setDrawing,
  onLocation,
  onCreateBlock,
}: {
  mode: Mode;
  blocked: BlockedZone[];
  radii: Rows["radii"];
  location: LatLng | null;
  locating: boolean;
  geoSource: GeoSource | null;
  storeName: string;
  drawing: Drawing;
  setDrawing: (d: Drawing) => void;
  onLocation: (at: LatLng) => void;
  onCreateBlock: (points: LatLng[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const [ready, setReady] = useState(false);
  // O clique no mapa lê o estado atual por estas refs (o listener nasce uma vez).
  const state = useRef({ drawing, onLocation, onCreateBlock, setDrawing });
  useEffect(() => {
    state.current = { drawing, onLocation, onCreateBlock, setDrawing };
  });

  useEffect(() => {
    let alive = true;
    void import("leaflet").then((leaflet) => {
      if (!alive || !box.current || map.current) return;
      L.current = leaflet;
      const m = leaflet.map(box.current, { zoomControl: true, attributionControl: true }).setView(location ?? BRAZIL, location ? 13 : 4);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
      leaflet.control.scale({ imperial: false, position: "bottomleft" }).addTo(m);
      layer.current = leaflet.layerGroup().addTo(m);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => {
        const at = { lat: e.latlng.lat, lng: e.latlng.lng };
        const { drawing: d } = state.current;
        if (d?.type === "store") {
          state.current.onLocation(at);
          state.current.setDrawing(null);
        } else if (d?.type === "polygon") {
          const first = d.points[0];
          // Fechar clicando perto do primeiro ponto (até 12 px).
          if (first && d.points.length >= 3 && m.latLngToContainerPoint(first).distanceTo(e.containerPoint) < 12) {
            state.current.onCreateBlock(d.points);
            state.current.setDrawing(null);
          } else {
            state.current.setDrawing({ ...d, points: [...d.points, at] });
          }
        }
      });
      map.current = m;
      setReady(true);
    });
    return () => {
      alive = false;
      map.current?.remove();
      map.current = null;
    };
    // O mapa nasce uma vez; o resto atualiza nas camadas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Centraliza na loja quando ela é marcada pela primeira vez.
  const centered = useRef(Boolean(location));
  useEffect(() => {
    if (ready && location && !centered.current) {
      centered.current = true;
      map.current?.setView(location, 13);
    }
  }, [ready, location]);

  useEffect(() => {
    const leaflet = L.current;
    const group = layer.current;
    if (!ready || !leaflet || !group) return;
    group.clearLayers();
    if (mode === "BY_RADIUS" && location) {
      radii.forEach((r, i) => {
        const km = Number(r.maxKm.replace(",", "."));
        if (km > 0) group.addLayer(leaflet.circle(location, { color: AREA_COLORS[i % AREA_COLORS.length], weight: 2, fillOpacity: 0.08, radius: km * 1000 }).bindTooltip(`até ${r.maxKm} km`));
      });
    }
    blocked.forEach((zone) => {
      group.addLayer(
        leaflet
          .polygon(zone.points, { color: BLOCK_COLOR, weight: 2, dashArray: "6 4", fillColor: BLOCK_COLOR, fillOpacity: 0.28 })
          .bindTooltip(zone.name, { sticky: true, className: "dd-area-label" }),
      );
    });
    if (drawing?.type === "polygon" && drawing.points.length) {
      group.addLayer(leaflet.polyline(drawing.points, { color: BLOCK_COLOR, weight: 2, dashArray: "4 4" }));
      drawing.points.forEach((p, i) => group.addLayer(leaflet.circleMarker(p, { radius: i === 0 ? 7 : 5, color: BLOCK_COLOR, fillColor: "#fff", fillOpacity: 1, weight: 2 })));
    }
    if (location) {
      const marker = leaflet.marker(location, {
        draggable: true,
        icon: leaflet.divIcon({ className: "", html: '<div class="dd-store-pin"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }),
        title: "Loja (arraste para ajustar)",
      });
      marker.on("dragend", () => {
        const at = marker.getLatLng();
        onLocation({ lat: at.lat, lng: at.lng });
      });
      marker.bindTooltip(storeName, { permanent: true, direction: "bottom", offset: [0, 18], className: "dd-store-label" });
      group.addLayer(marker);
    }
  }, [ready, mode, blocked, radii, location, drawing, storeName, onLocation]);

  // Ao trocar a forma de cobrar, enquadra o que vale para ela (os círculos do raio ou as áreas desenhadas).
  useEffect(() => {
    const leaflet = L.current;
    if (!ready || !leaflet || !location) return;
    const shapes = (layer.current?.getLayers() ?? []).filter((l): l is Leaflet.Circle | Leaflet.Polygon => l instanceof leaflet.Circle || l instanceof leaflet.Polygon);
    if (mode === "BY_DISTRICT" || shapes.length === 0) {
      map.current?.setView(location, 14);
      return;
    }
    const bounds = leaflet.latLngBounds([location, location]);
    shapes.forEach((s) => bounds.extend(s.getBounds()));
    map.current?.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    // Só na troca de forma: editar uma faixa não mexe no enquadramento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode]);

  const hint = useMemo(() => {
    if (locating) return "Procurando a loja no mapa pelo CEP e pelo endereço…";
    if (!location) return NO_LOCATION;
    if (mode === "BY_RADIUS" && !radii.some((r) => Number(r.maxKm.replace(",", ".")) > 0)) return "Adicione um raio ao lado: o círculo aparece aqui, a partir da loja.";
    if (geoSource && !drawing) return `Loja achada ${GEO_TEXT[geoSource]}. Salve para usar este ponto (dá para arrastar o pino).`;
    if (drawing?.type === "polygon") return drawing.points.length < 3 ? "Clique nos cantos da zona sem entrega no mapa." : "Clique no primeiro ponto para fechar a zona: ali não haverá entrega.";
    if (drawing?.type === "store") return "Clique no novo lugar da loja.";
    return null;
  }, [locating, location, mode, radii, geoSource, drawing]);

  return (
    <div className={cn(BLOCK, "relative min-w-0 flex-1 overflow-hidden")} style={{ height: 640 }}>
      <div ref={box} className="size-full" aria-label="Mapa das áreas de entrega" />
      <div className="absolute top-3 left-3 z-[500] flex flex-wrap gap-2">
        {location && (
          <Button
            size="sm"
            variant={drawing?.type === "polygon" ? "default" : "outline"}
            className="bg-surface shadow-sm"
            onClick={() => setDrawing(drawing?.type === "polygon" ? null : { type: "polygon", points: [] })}
          >
            <BanIcon aria-hidden /> Zona sem entrega
          </Button>
        )}
        {location && (
          <Button size="sm" variant="outline" className="bg-surface shadow-sm" onClick={() => setDrawing({ type: "store" })}>
            Mudar a loja de lugar
          </Button>
        )}
        {drawing && (
          <Button size="sm" variant="ghost" className="bg-surface shadow-sm" onClick={() => setDrawing(null)}>
            Cancelar
          </Button>
        )}
      </div>
      {hint && <div className="absolute right-3 bottom-8 left-3 z-[500] rounded-lg bg-ink px-3 py-2 text-[12.5px] text-paper shadow">{hint}</div>}
    </div>
  );
}
