"use client";

import {
  AddIntegrationRequest,
  CHANNEL_LABEL,
  type IntegrationDto,
  type IntegrationsDto,
  type IntegrationType,
} from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { type FacebookSdk, loadFacebookSdk, runEmbeddedSignup } from "@/lib/embedded-signup";
import { cn } from "@/lib/utils";

type Field = { name: string; label: string; placeholder?: string; secret?: boolean; numeric?: boolean };

/**
 * Cada sistema: o que a integração faz, como identificar a conta e, quando a conexão é por formulário, o que pedir.
 * O Instagram conecta pelo login do Instagram; o WhatsApp, pela janela da Meta (com o formulário só sem ela).
 */
const SYSTEMS: { type: IntegrationType; description: string; detail: (externalId: string) => string; help?: string; fields?: Field[] }[] = [
  {
    type: "WHATSAPP",
    description: "Números da WhatsApp Cloud API (Meta). As conversas de cada número chegam na Inbox.",
    detail: (id) => `ID do número ${id}`,
    help: "No app da Meta, em WhatsApp → Configuração da API. Use o token permanente de um usuário do sistema; o número precisa estar registrado na Cloud API.",
    fields: [
      { name: "phoneNumberId", label: "ID do número", placeholder: "Ex.: 997004416819345", numeric: true },
      { name: "wabaId", label: "ID da conta do WhatsApp Business (WABA)", placeholder: "Ex.: 25239395755710258", numeric: true },
      { name: "accessToken", label: "Token de acesso", secret: true },
    ],
  },
  {
    type: "INSTAGRAM",
    description: "Contas profissionais do Instagram. As DMs chegam na Inbox.",
    detail: (id) => `Conta ${id}`,
  },
  {
    type: "IFOOD",
    description: "Lojas do iFood. Os pedidos entram no cadastro do cliente e abrem conversas na Inbox.",
    detail: (id) => `Loja ${id}`,
    help: "O ID da loja (merchant ID) aparece no Portal do Parceiro do iFood.",
    fields: [
      { name: "merchantId", label: "ID da loja (merchant ID)" },
      { name: "name", label: "Nome (opcional)", placeholder: "Ex.: Loja Centro" },
    ],
  },
  {
    type: "CARDAPIO_WEB",
    description: "Lojas do Cardápio Web. Os pedidos entram no cadastro do cliente, achado pelo telefone.",
    detail: (id) => `Código da loja ${id}`,
    help: "A chave fica no Portal do Cardápio Web, em Configurações → Integrações → API. Ela é testada antes de salvar.",
    fields: [
      { name: "storeId", label: "Código da loja", placeholder: "Ex.: 13047", numeric: true },
      { name: "apiKey", label: "Chave de API", secret: true },
      { name: "name", label: "Nome (opcional)", placeholder: "Ex.: Loja Centro" },
    ],
  },
];

type System = (typeof SYSTEMS)[number];

const STATUS: Record<IntegrationDto["status"], { label: string; className: string; dot: string }> = {
  CONNECTED: { label: "Conectado", className: "border-success-line bg-success-lt text-success-ink", dot: "bg-success" },
  ERROR: { label: "Com erro", className: "border-tomate-line bg-tomate-lt text-tomate-ink", dot: "bg-tomate" },
  DISCONNECTED: { label: "Desconectado", className: "border-rule bg-surface-2 text-ink-3", dot: "bg-ink-3" },
};

/** Aba "Integrações" (board Configurações · Integrações): WhatsApp e Instagram na largura toda; iFood e Cardápio Web lado a lado. */
export function IntegrationsTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const integrations = useQuery({
    queryKey: ["integrations", tenant.id],
    queryFn: () => request<IntegrationsDto>(`/integrations?tenantId=${tenant.id}`),
  });
  if (!integrations.data) return <TabLoading failed={integrations.isError} />;

  return (
    <div className="grid items-start gap-3.5 lg:grid-cols-2">
      {SYSTEMS.map((system) => (
        <IntegrationSection
          key={`${tenant.id}-${system.type}`}
          system={system}
          data={integrations.data}
          wide={system.type === "WHATSAPP" || system.type === "INSTAGRAM"}
        />
      ))}
    </div>
  );
}

function IntegrationSection({ system, data, wide }: { system: System; data: IntegrationsDto; wide: boolean }) {
  const [adding, setAdding] = useState(false);
  const [disconnecting, setDisconnecting] = useState<IntegrationDto | null>(null);
  const label = CHANNEL_LABEL[system.type];
  const items = data.integrations.filter((integration) => integration.type === system.type);
  // Credencial da plataforma que falta neste servidor: as lojas ficam cadastradas, mas os pedidos não chegam.
  const pending =
    system.type === "IFOOD" && !data.platform.ifood
      ? {
          badge: "Credencial pendente",
          text: "A credencial da plataforma iFood ainda não foi configurada: as lojas ficam cadastradas, mas os pedidos só chegam depois disso.",
        }
      : system.type === "CARDAPIO_WEB" && !data.platform.cardapioWeb
        ? {
            badge: "Conexão desligada",
            text: "A conexão com a API do Cardápio Web está desligada neste servidor: a chave não é testada e os pedidos só chegam depois que ela for ligada.",
          }
        : null;
  // Bolinha do título: a situação da integração (pendente, com erro, conectada ou sem nenhuma conta).
  const dot = pending
    ? "bg-warning"
    : items.some((item) => item.status === "ERROR")
      ? "bg-tomate"
      : items.some((item) => item.status === "CONNECTED")
        ? "bg-success"
        : "bg-rule";

  let action: ReactNode;
  if (!data.canEdit) action = <p className="text-[12px] text-ink-3">Só o administrador do restaurante adiciona integrações.</p>;
  else if (adding) action = <IntegrationForm system={system} tenantId={data.tenantId} onClose={() => setAdding(false)} />;
  else if (system.type === "INSTAGRAM") action = <InstagramLogin tenantId={data.tenantId} enabled={data.platform.instagramLogin} />;
  else if (system.type === "WHATSAPP" && data.platform.whatsappSignup)
    action = <WhatsAppSignup tenantId={data.tenantId} ids={data.platform.whatsappSignup} />;
  else action = <AddButton label={label} onClick={() => setAdding(true)} />;

  return (
    <section
      className={cn("rounded-2xl border border-rule-soft bg-surface px-6 py-5", wide && "lg:col-span-2")}
      aria-labelledby={`integracao-${system.type}`}
    >
      <h2 id={`integracao-${system.type}`} className="mb-1 flex items-center gap-[9px] font-heading text-title font-semibold">
        <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
        {label}
        {pending && (
          <span className="ml-1 rounded-full border border-warning-line bg-warning-lt px-2 py-0.5 font-sans text-[11px] font-medium text-warning-ink">
            {pending.badge}
          </span>
        )}
      </h2>
      <p className="mb-3 leading-normal text-ink-2">{system.description}</p>
      {pending && (
        <p className="mb-3 rounded-xl border border-warning-line bg-warning-lt px-3.5 py-[11px] leading-normal text-warning-ink">{pending.text}</p>
      )}

      {items.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-2">
          {items.map((item) => {
            const status = STATUS[item.status];
            return (
              <li key={item.id} className="flex items-center justify-between gap-3 rounded-xl bg-paper px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium">{item.name}</div>
                  <div className="mt-0.5 truncate text-[12px] text-ink-3 tabular-nums">{system.detail(item.externalId)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={cn("inline-flex items-center gap-[5px] rounded-full border px-2.5 py-[3px] text-[12px] font-medium", status.className)}>
                    <span className={cn("size-[5px] rounded-full", status.dot)} aria-hidden />
                    {status.label}
                  </span>
                  {data.canEdit && item.status !== "DISCONNECTED" && (
                    <Button variant="outline" size="xs" className="bg-transparent" onClick={() => setDisconnecting(item)}>
                      Desconectar
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pt-1 pb-3 text-ink-3 italic">Nenhuma integração com o {label}.</p>
      )}

      {action}
      <DisconnectDialog tenantId={data.tenantId} label={label} item={disconnecting} onClose={() => setDisconnecting(null)} />
    </section>
  );
}

/** "Adicionar integração com o …": botão tracejado do board. */
function AddButton({ label, onClick, disabled }: { label: string; onClick: () => unknown; disabled?: boolean }) {
  return (
    <Button variant="outline" disabled={disabled} className="h-[33px] rounded-xl border-dashed bg-transparent px-3.5 text-ink-2" onClick={onClick}>
      <PlusIcon aria-hidden />
      Adicionar integração com o {label}
    </Button>
  );
}

function Failure({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2 text-[11.5px] text-tomate">
      {children}
    </p>
  );
}

/** Instagram: o botão abre a tela de login do Instagram; a volta (pela API) traz o resultado no endereço. */
function InstagramLogin({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const { request } = useAuth();
  const toast = useToast();
  const [failure, setFailure] = useState<string | null>(null);

  // Volta do login: ?instagram=conectado ou ?instagram=erro&motivo=…; o endereço é limpo para o aviso não se repetir.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("instagram");
    if (!result) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (result === "conectado") toast("Instagram conectado");
    else setFailure(params.get("motivo") ?? "Não foi possível conectar o Instagram.");
  }, []);

  async function login() {
    setFailure(null);
    try {
      const { url } = await request<{ url: string }>(`/integrations/${tenantId}/instagram/login`);
      window.location.assign(url);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível abrir o login do Instagram.");
    }
  }

  return (
    <div>
      <AddButton label="Instagram" disabled={!enabled} onClick={login} />
      {!enabled && <p className="mt-2 text-[11.5px] text-ink-3">O login do Instagram ainda não foi configurado neste servidor.</p>}
      {failure && <Failure>{failure}</Failure>}
    </div>
  );
}

/**
 * WhatsApp: abre o cadastro incorporado da Meta. Quem já usa o app WhatsApp Business escolhe conectar o app e
 * escaneia um QR code com o celular (Coexistência): o número continua funcionando no app.
 */
function WhatsAppSignup({ tenantId, ids }: { tenantId: string; ids: { appId: string; configId: string } }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [sdk, setSdk] = useState<FacebookSdk | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // O SDK carrega antes do clique: a janela da Meta precisa abrir no próprio clique, senão o navegador a bloqueia.
  useEffect(() => {
    loadFacebookSdk(ids.appId).then(setSdk, (error: Error) => setFailure(error.message));
  }, [ids.appId]);

  async function connect() {
    if (!sdk) return;
    setFailure(null);
    try {
      const result = await runEmbeddedSignup(sdk, ids.configId);
      if (!result) return; // janela fechada
      await request(`/integrations/${tenantId}/whatsapp/signup`, { method: "POST", body: result });
      await queryClient.invalidateQueries({ queryKey: ["integrations", tenantId] });
      toast("WhatsApp conectado");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Não foi possível conectar o WhatsApp.");
    }
  }

  return (
    <div>
      <AddButton label="WhatsApp" disabled={!sdk} onClick={connect} />
      {failure && <Failure>{failure}</Failure>}
    </div>
  );
}

/** Confirmação antes de desconectar: as mensagens e os pedidos da conta param de chegar. */
function DisconnectDialog({ tenantId, label, item, onClose }: { tenantId: string; label: string; item: IntegrationDto | null; onClose: () => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [failure, setFailure] = useState<string | null>(null);

  async function disconnect() {
    if (!item) return;
    setFailure(null);
    try {
      await request(`/integrations/${tenantId}/${item.id}/disconnect`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["integrations", tenantId] });
      toast(`${item.name} desconectado`);
      onClose();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível desconectar.");
    }
  }

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (open) return;
        setFailure(null);
        onClose();
      }}
    >
      <DialogContent className="w-[440px]">
        <div className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="mb-1">Desconectar {item?.name}?</DialogTitle>
          <DialogDescription>Integração com o {label}</DialogDescription>
        </div>
        <div className="px-6 py-[18px]">
          <p className="mb-4 text-[13px] leading-relaxed text-ink-2">
            As mensagens e os pedidos desta conta deixam de chegar, e as respostas pela Inbox não são mais enviadas por ela. As
            conversas e os pedidos já recebidos continuam no Comanda. Para voltar, adicione a integração de novo.
          </p>
          {failure && <p role="alert" className="mb-3 text-[11.5px] text-tomate">{failure}</p>}
          <div className="flex gap-2">
            <Button variant="destructive" onClick={disconnect}>
              Desconectar
            </Button>
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Formulário de uma nova integração: a API confere a credencial no sistema antes de salvar. */
function IntegrationForm({ system, tenantId, onClose }: { system: System; tenantId: string; onClose: () => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const label = CHANNEL_LABEL[system.type];
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const [submit, saving] = usePendingAction(async () => {
    setFailure(null);
    // Campos em branco (o nome opcional) ficam de fora.
    const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
    const parsed = AddIntegrationRequest.safeParse({ type: system.type, ...filled });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.code === "invalid_type" ? "Preencha este campo." : issue.message;
      setErrors(next);
      return;
    }
    try {
      await request(`/integrations/${tenantId}`, { method: "POST", body: parsed.data });
      await queryClient.invalidateQueries({ queryKey: ["integrations", tenantId] });
      toast(`Integração com o ${label} adicionada`);
      onClose();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível conectar.");
    }
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-2.5 rounded-xl bg-paper px-4 py-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="text-[13px] font-medium">Nova integração com o {label}</div>
      {system.fields?.map((field) => (
        <div key={field.name} className="flex flex-col gap-1">
          <Label htmlFor={`${id}-${field.name}`}>{field.label}</Label>
          <Input
            id={`${id}-${field.name}`}
            type={field.secret ? "password" : "text"}
            inputMode={field.numeric ? "numeric" : undefined}
            // Credenciais não devem ser lembradas pelo navegador.
            autoComplete={field.secret ? "new-password" : "off"}
            placeholder={field.placeholder}
            value={values[field.name] ?? ""}
            aria-invalid={Boolean(errors[field.name]) || undefined}
            onChange={(event) => {
              setValues((current) => ({ ...current, [field.name]: event.target.value }));
              setErrors((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== field.name)));
            }}
          />
          {errors[field.name] && (
            <p role="alert" className="text-[11px] text-tomate">
              {errors[field.name]}
            </p>
          )}
        </div>
      ))}
      <p className="text-[11.5px] leading-normal text-ink-3">{system.help}</p>
      {failure && (
        <p role="alert" className="text-[11px] text-tomate">
          {failure}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" loading={saving}>
          Conectar
        </Button>
      </div>
    </form>
  );
}
