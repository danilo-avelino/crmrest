"use client";

import { CreateMemberRequest, type TeamMemberDto, type UpdateMemberRequest } from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Aba "Usuários": quem atende no restaurante. O admin muda o papel e desativa ou reativa o acesso. */
export function MembersTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const canEdit = tenant.role === "ADMIN";
  const members = useQuery({
    queryKey: ["members-settings", tenant.id],
    queryFn: () => request<TeamMemberDto[]>(`/settings/${tenant.id}/members`),
  });
  if (!members.data) return <TabLoading failed={members.isError} />;

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Usuários</h2>
        <p className="mt-1 text-ink-2">
          Administradores alteram as configurações e os dados dos clientes; atendentes atendem as conversas. Quem for desativado
          perde o acesso a este restaurante em até 15 minutos.
        </p>
      </div>
      {canEdit && <CreateMemberForm tenantId={tenant.id} />}
      <ul>
        {members.data.map((member) => (
          <MemberRow key={member.userId} tenantId={tenant.id} member={member} canEdit={canEdit && !member.isYou} />
        ))}
      </ul>
      <p className="border-t border-rule bg-paper px-5 py-3 text-[12px] text-ink-3">
        {canEdit
          ? "Novos usuários entram com a senha temporária definida aqui. Ninguém altera o próprio acesso."
          : "Só o administrador do restaurante altera os usuários."}
      </p>
    </section>
  );
}

function CreateMemberForm({ tenantId }: { tenantId: string }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<CreateMemberRequest["role"]>("AGENT");
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string; form?: string }>({});

  const [save, saving] = usePendingAction(async () => {
    const parsed = CreateMemberRequest.safeParse({ name, email, password, role });
    if (!parsed.success) {
      const field = (fieldName: keyof typeof errors) => parsed.error.issues.find((issue) => issue.path[0] === fieldName)?.message;
      return setErrors({ name: field("name"), email: field("email"), password: field("password") });
    }
    setErrors({});
    try {
      const updated = await request<TeamMemberDto[]>(`/settings/${tenantId}/members`, { method: "POST", body: parsed.data });
      queryClient.setQueryData(["members-settings", tenantId], updated);
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      toast(`${parsed.data.name} foi adicionado`);
      setName("");
      setEmail("");
      setPassword("");
      setRole("AGENT");
    } catch (failure) {
      setErrors({ form: failure instanceof ApiError ? failure.message : "Não foi possível criar o usuário." });
    }
  });

  return (
    <form
      noValidate
      className="border-b border-rule-soft bg-paper px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="mb-3 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Novo usuário</div>
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>Nome</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            autoComplete="name"
            aria-invalid={Boolean(errors.name) || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-email`}>E-mail</Label>
          <Input
            id={`${id}-email`}
            type="email"
            value={email}
            autoComplete="email"
            aria-invalid={Boolean(errors.email) || undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-password`}>Senha temporária</Label>
          <Input
            id={`${id}-password`}
            type="password"
            value={password}
            maxLength={128}
            autoComplete="new-password"
            aria-invalid={Boolean(errors.password) || undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] leading-none font-medium text-ink-2">Perfil</legend>
          <div className="grid h-9 grid-cols-2 rounded-lg border border-input bg-surface p-0.5">
            {[
              ["AGENT", "Atendimento"],
              ["ADMIN", "Admin"],
            ].map(([value, label]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-center justify-center rounded-md text-[12px] font-medium transition-colors",
                  role === value ? "bg-ink text-paper" : "text-ink-3 hover:text-ink-2",
                )}
              >
                <input
                  type="radio"
                  name={`${id}-role`}
                  value={value}
                  checked={role === value}
                  onChange={() => setRole(value as CreateMemberRequest["role"])}
                  className="sr-only"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {[errors.name, errors.email, errors.password, errors.form].filter(Boolean).map((message) => (
        <p key={message} role="alert" className="mt-2 text-[11px] text-tomate">
          {message}
        </p>
      ))}
      <div className="mt-3 flex justify-end">
        <Button type="submit" size="sm" loading={saving}>
          <PlusIcon aria-hidden />
          Criar usuário
        </Button>
      </div>
    </form>
  );
}

function MemberRow({ tenantId, member, canEdit }: { tenantId: string; member: TeamMemberDto; canEdit: boolean }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const change = async (body: UpdateMemberRequest, message: string) => {
    setError(null);
    try {
      const updated = await request<TeamMemberDto[]>(`/settings/${tenantId}/members/${member.userId}`, { method: "PATCH", body });
      queryClient.setQueryData(["members-settings", tenantId], updated);
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      toast(message);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível alterar.");
    }
  };

  return (
    <li className={cn("flex items-center gap-3 border-b border-rule-soft px-5 py-3 last:border-b-0", !member.isActive && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {member.name}
          {member.isYou && <span className="ml-1.5 text-[11px] font-normal text-ink-3">(você)</span>}
        </div>
        <div className="truncate text-[12px] text-ink-3">{member.email}</div>
        {error && <p className="text-[11px] text-tomate">{error}</p>}
      </div>
      <span className="w-24 text-[12px] text-ink-2">
        {member.role === "ADMIN" ? "Administrador" : "Atendente"}
        {!member.isActive && <span className="block text-[11px] text-ink-3">desativado</span>}
      </span>
      {canEdit && (
        <div className="flex shrink-0 gap-1.5">
          {member.isActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                member.role === "ADMIN"
                  ? change({ role: "AGENT" }, `${member.name} agora é atendente`)
                  : change({ role: "ADMIN" }, `${member.name} agora é administrador`)
              }
            >
              {member.role === "ADMIN" ? "Tornar atendente" : "Tornar administrador"}
            </Button>
          )}
          <Button
            variant={member.isActive ? "destructive" : "outline"}
            size="sm"
            onClick={() =>
              change({ isActive: !member.isActive }, member.isActive ? `${member.name} foi desativado` : `${member.name} foi reativado`)
            }
          >
            {member.isActive ? "Desativar" : "Reativar"}
          </Button>
        </div>
      )}
    </li>
  );
}
