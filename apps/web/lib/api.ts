export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Chama a API (via /api, mesma origem) e devolve o JSON; erros viram ApiError com a mensagem da API. */
export async function apiRequest<T>(
  path: string,
  { method = "GET", body, token }: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
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
  return (response.status === 204 ? undefined : await response.json()) as T;
}
