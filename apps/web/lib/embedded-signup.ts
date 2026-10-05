import type { WhatsAppSignupRequest } from "@comanda/shared";

/** O pedaço do SDK do Facebook (JS) que o cadastro incorporado usa. */
export type FacebookSdk = {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(callback: (response: { authResponse?: { code?: string } | null }) => void, options: object): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FacebookSdk> | null = null;

/** Carrega o SDK uma vez só. Carregar antes do clique evita que o navegador bloqueie a janela da Meta. */
export function loadFacebookSdk(appId: string): Promise<FacebookSdk> {
  loading ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      const sdk = window.FB as FacebookSdk;
      sdk.init({ appId, autoLogAppEvents: true, xfbml: false, version: "v24.0" });
      resolve(sdk);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/pt_BR/sdk.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      loading = null;
      reject(new Error("Não foi possível carregar a janela da Meta. Confira a conexão e tente de novo."));
    };
    document.body.appendChild(script);
  });
  return loading;
}

/**
 * Abre o cadastro incorporado do WhatsApp (com a opção de manter o número no app WhatsApp Business, a Coexistência).
 * Junta o código do login com a conta escolhida, que a janela da Meta manda por postMessage (quando manda).
 * Devolve null quando a pessoa fecha a janela. Chamar dentro do clique, sem await antes: senão a janela é bloqueada.
 */
export function runEmbeddedSignup(sdk: FacebookSdk, configId: string): Promise<WhatsAppSignupRequest | null> {
  return new Promise((resolve, reject) => {
    let code: string | undefined;
    let session: Omit<WhatsAppSignupRequest, "code"> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (finish: () => void) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      finish();
    };
    const complete = () => {
      if (code && session) {
        const result = { code, ...session };
        done(() => resolve(result));
      }
    };

    function onMessage(event: MessageEvent) {
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname) || typeof event.data !== "string") return;
      let message: { type?: string; event?: string; data?: { waba_id?: string; phone_number_id?: string; error_message?: string } };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type !== "WA_EMBEDDED_SIGNUP") return;
      if (message.event === "CANCEL") done(() => resolve(null));
      else if (message.event === "ERROR") done(() => reject(new Error(message.data?.error_message ?? "A Meta recusou o cadastro.")));
      else if (message.event?.startsWith("FINISH") && message.data?.waba_id) {
        session = {
          wabaId: message.data.waba_id,
          phoneNumberId: message.data.phone_number_id || undefined,
          // Número que continua no app WhatsApp Business do celular (conectado pelo QR code).
          coexistence: message.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
        };
        complete();
      }
    }

    window.addEventListener("message", onMessage);
    sdk.login(
      (response) => {
        code = response.authResponse?.code;
        if (!code) return done(() => resolve(null));
        complete();
        // O código veio, mas a conta escolhida não (ex.: "continuar com as configurações anteriores"): a API descobre a conta pelo token.
        if (!session) timer = setTimeout(() => done(() => resolve({ code: code as string })), 3_000);
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
      },
    );
  });
}
