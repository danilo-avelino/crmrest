"use client";

import { renderTemplate, type WhatsAppTemplate } from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeftIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Botão "Template" do composer: escolhe um template aprovado do WhatsApp e preenche as variáveis. */
export function TemplatePicker({ conversationId, emphasized }: { conversationId: string; emphasized: boolean }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<WhatsAppTemplate | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ["templates", conversationId],
    queryFn: () => request<WhatsAppTemplate[]>(`/conversations/${conversationId}/templates`),
    enabled: open,
  });

  const choose = (template: WhatsAppTemplate | null) => {
    setSelected(template);
    setValues(template ? Array.from({ length: template.variables }, () => "") : []);
    setError(null);
  };

  const [send, sending] = usePendingAction(async () => {
    if (!selected) return;
    setError(null);
    try {
      await request(`/conversations/${conversationId}/templates`, {
        method: "POST",
        body: { name: selected.name, language: selected.language, variables: values.map((value) => value.trim()) },
      });
      for (const queryKey of [["messages", conversationId], ["conversation", conversationId], ["conversations"]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      setOpen(false);
      choose(null);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível enviar o template.");
    }
  });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) choose(null);
      }}
    >
      <PopoverTrigger
        render={<Button variant="outline" size="sm" className={cn("text-[11.5px]", emphasized && "border-ink text-ink")} />}
      >
        Template
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        {!selected ? (
          <>
            <div className="text-[11px] font-medium text-ink-3">Templates aprovados do WhatsApp</div>
            {templates.isPending ? (
              <div className="flex items-center gap-2 py-2 text-ink-3">
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden /> Carregando…
              </div>
            ) : templates.isError ? (
              <p className="text-[12px] text-tomate">
                {templates.error instanceof ApiError ? templates.error.message : "Templates indisponíveis."}
              </p>
            ) : templates.data.length === 0 ? (
              <p className="text-[12px] text-ink-3">Nenhum template aprovado nesta conta.</p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {templates.data.map((template) => (
                  <li key={`${template.name}-${template.language}`}>
                    <button
                      type="button"
                      onClick={() => choose(template)}
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                    >
                      <span className="text-[12px] font-medium">{template.name}</span>
                      <span className="line-clamp-2 text-[11.5px] text-ink-3">{template.body}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex items-center gap-1 self-start text-[11px] text-ink-3 hover:text-ink-2"
            >
              <ChevronLeftIcon className="size-3" aria-hidden /> {selected.name}
            </button>
            <p className="rounded-lg border border-rule bg-paper px-3 py-2 text-[12.5px] leading-[1.4] whitespace-pre-wrap">
              {renderTemplate(selected.body, values.map((value, index) => value.trim() || `{{${index + 1}}}`))}
            </p>
            {values.map((value, index) => (
              <div key={index} className="flex flex-col gap-1">
                <Label htmlFor={`template-variable-${index}`}>{`Variável {{${index + 1}}}`}</Label>
                <Input
                  id={`template-variable-${index}`}
                  value={value}
                  required
                  onChange={(event) => setValues((current) => current.map((v, i) => (i === index ? event.target.value : v)))}
                />
              </div>
            ))}
            {error && (
              <p role="alert" className="text-[11px] text-tomate">
                {error}
              </p>
            )}
            <Button type="submit" variant="accent" size="sm" loading={sending} disabled={values.some((value) => !value.trim())}>
              Enviar template
            </Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
