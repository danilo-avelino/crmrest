import type { TenantSettingsDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-provider";
import { useSettingsTenant } from "@/components/settings/settings-shell";

/** Configurações de todos os restaurantes do usuário. */
export function useSettingsList(options?: { refetchInterval?: number }) {
  const { request } = useAuth();
  return useQuery({ queryKey: ["settings"], queryFn: () => request<TenantSettingsDto[]>("/settings"), ...options });
}

/** Configurações do restaurante escolhido no painel. */
export function useCurrentSettings() {
  const tenant = useSettingsTenant();
  const settings = useSettingsList();
  return { current: settings.data?.find((item) => item.tenantId === tenant.id), failed: settings.isError };
}

/** Grava uma configuração do restaurante (`PUT /settings/:tenantId/:path`) e atualiza a lista em cache. */
export function useSaveSettings() {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  return async (tenantId: string, path: string, body: object) => {
    const updated = await request<TenantSettingsDto>(`/settings/${tenantId}/${path}`, { method: "PUT", body });
    queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) => list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)));
    return updated;
  };
}
