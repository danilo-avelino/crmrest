import { describe, expect, it } from "vitest";
import { addressKey, addressText } from "../src/orders/address-key.js";

const ifood = (complement?: string, extra: object = {}) => ({
  streetName: "Rua das Acácias",
  streetNumber: "120",
  neighborhood: "Vila Mariana",
  city: "São Paulo",
  state: "SP",
  postalCode: "04000000",
  ...(complement && { complement }),
  ...extra,
});
const cardapioWeb = (complement?: string, extra: object = {}) => ({
  street: "R. das Acacias",
  number: "120",
  neighborhood: "V. Mariana",
  city: "SAO PAULO",
  state: "sp",
  ...(complement && { complement }),
  ...extra,
});

describe("chave do endereço (alerta de fraude)", () => {
  it("o mesmo endereço em iFood e Cardápio Web dá a mesma chave: sem acentos, maiúsculas e abreviações", () => {
    expect(addressKey(ifood())).toBe(addressKey(cardapioWeb()));
    expect(addressKey({ ...ifood(), streetName: "Av. Paulista" })).toBe(addressKey({ ...cardapioWeb(), street: "AVENIDA PAULISTA" }));
    expect(addressKey({ ...ifood(), streetName: "R. Dr. Arnaldo" })).toBe(addressKey({ ...cardapioWeb(), street: "Rua Doutor Arnaldo" }));
  });

  it("bloco e apartamento valem em qualquer ordem e abreviação", () => {
    const expected = addressKey(ifood("Bloco 2, Apartamento 31"));
    for (const complement of ["Bl 2 ap 31", "Apto 31 bloco 2", "AP31 BL2", "ap. 31 - bl. 2", "Torre 2 / Apt 031"]) {
      expect(addressKey(cardapioWeb(complement)), complement).toBe(expected);
    }
  });

  it("olha todos os campos, não só o complemento", () => {
    const expected = addressKey(ifood("Cond. Jardim Sul, Bloco B, apto 34"));
    // Bloco no campo próprio do Cardápio Web.
    expect(addressKey(cardapioWeb("Condomínio Jardim Sul apto 34", { address_block: "B" }))).toBe(expected);
    // Apartamento escrito na referência.
    expect(addressKey(cardapioWeb("Condominio Jardim Sul bloco b", { reference: "apto 34" }))).toBe(expected);
    // Tudo junto na linha da rua.
    expect(addressKey({ street: "Rua das Acácias, 120, Cond Jardim Sul, Bl B, Ap 34", city: "São Paulo", state: "SP" })).toBe(expected);
    // Lote no campo próprio.
    expect(addressKey(cardapioWeb("quadra 4", { address_lot: "7" }))).toBe(addressKey(ifood("Qd 4 Lt 7")));
  });

  it("endereço parecido não conta", () => {
    const base = addressKey(ifood("Bloco B, apto 34"));
    expect(addressKey(ifood("Bloco B, apto 35"))).not.toBe(base);
    expect(addressKey(ifood("Bloco C, apto 34"))).not.toBe(base);
    expect(addressKey(ifood("apto 34"))).not.toBe(base);
    expect(addressKey(ifood())).not.toBe(base);
    expect(addressKey({ ...ifood("Bloco B, apto 34"), streetNumber: "121" })).not.toBe(base);
    expect(addressKey({ ...ifood("Bloco B, apto 34"), streetName: "Rua das Acácias Brancas" })).not.toBe(base);
    expect(addressKey({ ...ifood("Bloco B, apto 34"), city: "Santos" })).not.toBe(base);
    expect(addressKey(ifood("Fundos"))).not.toBe(addressKey(ifood()));
    expect(addressKey(ifood("Casa 2"))).not.toBe(addressKey(ifood("Casa 3")));
  });

  it("a referência em texto livre não separa endereços; a rua com nome de unidade não vira unidade", () => {
    expect(addressKey(ifood(undefined, { reference: "Portão azul, perto do mercado" }))).toBe(addressKey(ifood()));
    expect(addressKey({ ...ifood(), streetName: "Rua Casa Branca" })).toContain("rua casa branca|120");
  });

  it("sem rua, cidade ou número não dá para dizer que é idêntico", () => {
    expect(addressKey(null)).toBeNull();
    expect(addressKey({})).toBeNull();
    expect(addressKey({ ...ifood(), streetNumber: "S/N" })).toBeNull();
    expect(addressKey({ streetName: "Rua A", city: "São Paulo" })).toBeNull();
  });

  it("texto para a equipe ler", () => {
    expect(addressText(cardapioWeb("Cond. Jardim Sul, apto 34", { address_block: "B" }))).toBe(
      "R. das Acacias, 120 · Bloco B, Cond. Jardim Sul, apto 34 · V. Mariana",
    );
    expect(addressText(null)).toBeNull();
  });
});
