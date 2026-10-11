export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type ApiInit = { method?: string; body?: unknown; token?: string | null };

/** Chama a API (via /api, mesma origem); erros viram ApiError com a mensagem da API. */
async function apiFetch(path: string, { method = "GET", body, token }: ApiInit): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof payload?.message === "string" ? payload.message : "Algo deu errado. Tente novamente.";
    throw new ApiError(response.status, message);
  }
  return response;
}

/** Chama a API e devolve o JSON. */
export async function apiRequest<T>(path: string, init: ApiInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Baixa um arquivo da API (ex.: a imagem ou o áudio de uma mensagem). */
export async function apiDownload(path: string, token: string | null): Promise<Blob> {
  return (await apiFetch(path, { token })).blob();
}
