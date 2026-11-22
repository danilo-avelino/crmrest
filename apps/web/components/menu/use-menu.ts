"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ApiError } from "@/lib/api";
import type { MenuTree } from "@/lib/menu";

export function useTenantId(): string | null {
  const { session } = useAuth();
  return session?.context?.tenants[0]?.id ?? null;
}

/** O cardápio inteiro (`GET /menu/:tenantId`). Responde 403 quando o módulo Cardápio não está ligado. */
export function useMenu(options?: { retry?: boolean }) {
  const { request } = useAuth();
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ["menu", tenantId],
    queryFn: () => request<MenuTree>(`/menu/${tenantId}`),
    enabled: Boolean(tenantId),
    retry: options?.retry ?? false,
    staleTime: 60_000,
  });
}

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PHOTO_MAX_BYTES = 1024 * 1024;

/** Valida a foto antes de enviar: formato e tamanho (a API confere de novo). */
export function photoProblem(file: { name: string; type: string; size: number }): string | null {
  if (!PHOTO_TYPES.includes(file.type) || file.size > PHOTO_MAX_BYTES || file.size === 0) {
    return `${file.name} não foi enviada: use JPG, PNG ou WEBP de até 1 MB.`;
  }
  return null;
}

/**
 * Chamadas que alteram o cardápio. Depois de cada uma o cache é recarregado; o erro (em português) fica em `error`.
 * `call` devolve undefined quando falha, para o chamador não seguir adiante.
 */
export function useMenuActions() {
  const { request, session, reload } = useAuth();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["menu", tenantId] });

  async function call<T = unknown>(path: string, method: string, body?: unknown): Promise<{ data: T } | undefined> {
    setError(null);
    try {
      const data = await request<T>(`/menu/${tenantId}${path}`, { method, body });
      await refresh();
      return { data };
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível salvar. Tente de novo.");
      return undefined;
    }
  }

  /** `PUT /menu/:tenantId/items/:id/photo`: o arquivo vai no corpo, com o tipo da imagem. */
  async function uploadPhoto(itemId: string, file: File): Promise<{ photoUrl: string | null } | undefined> {
    setError(null);
    const problem = photoProblem(file);
    if (problem) {
      setError(problem);
      return undefined;
    }
    const send = (token: string | null) =>
      fetch(`/api/menu/${tenantId}/items/${itemId}/photo`, {
        method: "PUT",
        headers: { "Content-Type": file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: file,
      });
    try {
      let response = await send(session?.accessToken ?? null);
      if (response.status === 401) response = await send((await reload())?.accessToken ?? null);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
        setError(
          typeof payload?.message === "string"
            ? payload.message
            : response.status === 404
              ? "O envio de fotos ainda não está disponível. Tente mais tarde."
              : `${file.name} não foi enviada: use JPG, PNG ou WEBP de até 1 MB.`,
        );
        return undefined;
      }
      const item = (await response.json()) as { photoUrl: string | null };
      await refresh();
      return item;
    } catch {
      setError("Não foi possível enviar a foto. Confira a conexão e tente de novo.");
      return undefined;
    }
  }

  return { call, uploadPhoto, error, setError, tenantId };
}
