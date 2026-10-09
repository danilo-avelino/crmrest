"use client";

import type { ContactDetail } from "@dishdesk/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";

type Props = { contact: ContactDetail; open: boolean; onOpenChange: (open: boolean) => void };

/** LGPD, direito de acesso: gera o arquivo com tudo o que o restaurante guarda sobre o cliente. */
export function ExportDialog({ contact, open, onOpenChange }: Props) {
  const { request } = useAuth();
  const [file, setFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // O arquivo fica na memória do navegador só enquanto o modal está aberto.
  const close = () => {
    if (file) URL.revokeObjectURL(file);
    setFile(null);
    setError(null);
    onOpenChange(false);
  };

  const generate = async () => {
    setError(null);
    try {
      const data = await request<unknown>(`/contacts/${contact.id}/export`);
      setFile(URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível gerar o arquivo.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <div className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="mb-1">Exportar dados do cliente</DialogTitle>
          <DialogDescription>{contact.name ?? "Cliente sem nome"} · LGPD — direito de acesso</DialogDescription>
        </div>
        <div className="px-6 py-[18px]">
          <p className="mb-3.5 text-[13px] leading-relaxed text-ink-2">
            O arquivo incluirá: cadastro completo, canais vinculados, endereços, consentimentos, todas as conversas e pedidos.
          </p>
          <div className="mb-[18px] flex items-center gap-2 rounded-[7px] border border-[#FDE68A] bg-warning-lt px-3.5 py-2.5">
            <TriangleAlertIcon className="size-3.5 shrink-0 text-[#D97706]" aria-hidden />
            <span className="text-xs text-warning-ink">Esta ação ficará registrada no histórico de auditoria.</span>
          </div>
          {error && (
            <p role="alert" className="mb-3 flex items-center gap-[5px] text-[11.5px] text-tomate">
              <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <div className="flex gap-2">
            {file ? (
              <a href={file} download={`cliente-${contact.id}.json`} className={buttonVariants()}>
                Baixar
              </a>
            ) : (
              <Button onClick={generate}>Gerar arquivo</Button>
            )}
            <Button variant="outline" onClick={close}>
              {file ? "Fechar" : "Cancelar"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** LGPD, eliminação: apaga os dados pessoais; só libera depois de digitar o nome do cliente. */
export function AnonymizeDialog({ contact, open, onOpenChange }: Props) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const expected = contact.name ?? "ANONIMIZAR";
  const confirmed = typed.trim().toLowerCase() === expected.trim().toLowerCase();

  const anonymize = async () => {
    setError(null);
    try {
      const updated = await request<ContactDetail>(`/contacts/${contact.id}/anonymize`, { method: "POST" });
      queryClient.setQueryData(["contact", contact.id], updated);
      for (const key of ["contacts", "contact-filters", "contact-duplicates", "contact-conversations", "conversations"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onOpenChange(false);
      toast("Cliente anonimizado");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível anonimizar.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="w-[460px]">
        <div className="border-b border-tomate-line bg-tomate-lt px-6 py-5">
          <div className="mb-1 flex items-center gap-2">
            <AlertCircleIcon className="size-4 text-tomate" aria-hidden />
            <DialogTitle className="text-tomate-ink">Anonimizar cliente</DialogTitle>
          </div>
          <DialogDescription className="text-tomate">{contact.name ?? "Cliente sem nome"} · ação irreversível</DialogDescription>
        </div>
        <div className="px-6 py-[18px]">
          <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
            Os dados a seguir serão <strong>apagados permanentemente:</strong>
          </p>
          <ul className="mb-3.5 ml-4 list-disc text-[12.5px] leading-loose text-ink-2">
            <li>Nome, telefone, e-mail, data de nascimento</li>
            <li>CPF e documentos</li>
            <li>Endereços de entrega</li>
            <li>Canais vinculados</li>
          </ul>
          <p className="mb-4 rounded-md bg-paper px-3.5 py-2.5 text-[12.5px] leading-normal text-ink-3">
            Pedidos e conversas são mantidos sem identificação pessoal, para uso nos relatórios do restaurante.
          </p>
          <div className="mb-3.5 flex flex-col gap-[5px]">
            <Label htmlFor="anonymize-confirm" className="text-[11.5px]">
              {contact.name ? "Para confirmar, digite o nome do cliente:" : "Para confirmar, digite ANONIMIZAR:"}
            </Label>
            <Input id="anonymize-confirm" value={typed} placeholder={expected} onChange={(event) => setTyped(event.target.value)} />
          </div>
          {error && (
            <p role="alert" className="mb-3 flex items-center gap-[5px] text-[11.5px] text-tomate">
              <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="accent" disabled={!confirmed} onClick={anonymize}>
              Anonimizar
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
