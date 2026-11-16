import { describe, expect, it } from "vitest";
import { isAcknowledgment } from "../src/automations/automation.js";

describe("agradecimento ou confirmação do cliente não chama o atendente", () => {
  it.each(["Ok", "ok!", "Okkk", "Mt obrigadaa", "Muito obrigado!", "valeu, boa noite", "Obrigada pela atenção 😊", "👍", "Tá bom", "Beleza, fico no aguardo", "kkkk obg"])(
    "%s",
    (text) => expect(isAcknowledgment(text)).toBe(true),
  );

  it.each([
    "Ok?",
    "Ok, mas ainda não chegou",
    "14,00",
    "6140",
    "Por gentileza",
    "Manda muito molho e pepino",
    "Oi se puder agilizar viu",
    "Sim",
    "",
    undefined,
  ])("%s chama", (text) => expect(isAcknowledgment(text)).toBe(false));
});
