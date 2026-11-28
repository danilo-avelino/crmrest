/** Dados do site público usados nas tags de SEO, no sitemap e no robots.txt. */

export const SITE_URL = "https://www.dishdesk.com.br";
export const SITE_NAME = "Dish Desk";

/** Imagem de compartilhamento (1200x630) em public/. */
export const OG_IMAGE = { url: "/og-image.png", width: 1200, height: 630, alt: "Dish Desk: atendimento com IA para restaurantes" };

/** Páginas do site institucional que entram no sitemap. A /extensao fica de fora porque tem noindex. */
export const SITE_PAGES = ["/", "/funcionalidades", "/demo", "/privacidade", "/exclusao-de-dados"];

/**
 * Áreas do painel, todas atrás de login: o robots.txt pede para não rastrear.
 * O cardápio público de cada restaurante (/c/...) continua liberado.
 */
export const PRIVATE_PATHS = [
  "/api/",
  "/inbox",
  "/pedidos",
  "/clientes",
  "/avaliacoes",
  "/cardapio",
  "/configuracoes",
  "/assinatura",
  "/assistente",
  "/plataforma",
  "/redefinir-senha",
];
