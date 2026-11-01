/** Tema do painel: claro, escuro ou o do sistema. A escolha fica no navegador. */
export type Theme = "light" | "dark" | "system";

export const THEME_KEY = "dd-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Roda no <head>, antes da primeira pintura, para a página não piscar no tema errado.
 * Mesma regra de applyTheme, escrita à mão porque vai como texto.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("${DARK_QUERY}").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function saveTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Sem armazenamento (aba anônima bloqueada): o tema vale só até recarregar.
  }
  applyTheme(theme);
}

/** No tema do sistema, acompanha a troca de claro/escuro feita no computador com o painel aberto. */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (readTheme() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
