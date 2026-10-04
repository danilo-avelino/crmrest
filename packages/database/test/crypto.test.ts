import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blindIndex, decrypt, encrypt, parseEncryptionKey } from "../src/crypto.js";

const key = randomBytes(32);

describe("criptografia", () => {
  it("cifra e decifra, com resultado diferente a cada vez", () => {
    const first = encrypt('{"accessToken":"EAAG..."}', key);
    const second = encrypt('{"accessToken":"EAAG..."}', key);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(decrypt(first, key)).toBe('{"accessToken":"EAAG..."}');
  });

  it("recusa conteúdo adulterado ou chave errada", () => {
    const data = encrypt("12345678909", key);
    data[data.length - 1]! ^= 1;
    expect(() => decrypt(data, key)).toThrow();
    expect(() => decrypt(encrypt("12345678909", key), randomBytes(32))).toThrow();
  });

  it("índice cego é determinístico por chave", () => {
    expect(blindIndex("12345678909", key)).toBe(blindIndex("12345678909", key));
    expect(blindIndex("12345678909", key)).not.toBe(blindIndex("12345678909", randomBytes(32)));
  });

  it("exige chave de 32 bytes", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(parseEncryptionKey(key.toString("base64")).equals(key)).toBe(true);
  });
});
