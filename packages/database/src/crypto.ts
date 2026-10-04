import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

// Dados sensíveis em repouso (§8): credenciais de canais e CPF.

/** ENCRYPTION_KEY: 32 bytes em base64. */
export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY deve ter 32 bytes em base64");
  return key;
}

/** AES-256-GCM. Formato: iv (12 bytes) + tag (16 bytes) + conteúdo. */
export function encrypt(plaintext: string, key: Buffer): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const content = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), content]));
}

export function decrypt(data: Uint8Array, key: Buffer): string {
  const buffer = Buffer.from(data);
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}

/** HMAC-SHA256 para buscar e deduplicar valores sensíveis (ex.: CPF) sem guardá-los em claro. */
export function blindIndex(value: string, key: Buffer): string {
  const subkey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "comanda:blind-index", 32));
  return createHmac("sha256", subkey).update(value).digest("hex");
}
