import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEncryptionKey } from "@dishdesk/database";
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";

/**
 * Storage de objetos no Supabase Storage do Dish Desk (docs/cardapio-ia, decisão D3), pela API REST, sem SDK.
 * Toda chave nasce aqui: `tenants/{tenantId}/{kind}/{uuid}.{ext}`, com o restaurante vindo do contexto do servidor.
 * Fotos e logo ficam no bucket público; áudio e QR do Pix no privado, lidos só por URL assinada.
 */
export const PUBLIC_BUCKET = "menu-public";
export const PRIVATE_BUCKET = "menu-private";

const MB = 1024 * 1024;
// Foto, logo e capa chegam já recortadas e comprimidas pelo navegador (F2-14): até 1 MB.
const KINDS = {
  photo: { bucket: PUBLIC_BUCKET, maxBytes: 1 * MB, mimes: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } },
  logo: { bucket: PUBLIC_BUCKET, maxBytes: 1 * MB, mimes: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } },
  audio: {
    bucket: PRIVATE_BUCKET,
    maxBytes: 16 * MB,
    mimes: { "audio/ogg": "ogg", "audio/opus": "opus", "audio/mpeg": "mp3", "audio/mp4": "m4a" },
  },
  qr: { bucket: PRIVATE_BUCKET, maxBytes: 1 * MB, mimes: { "image/png": "png" } },
  // Foto ou PDF do cardápio impresso para a importação por IA (F2-10); a imagem tem limite menor (5 MB, o da API do Claude).
  import: {
    bucket: PRIVATE_BUCKET,
    maxBytes: 10 * MB,
    mimes: { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
  },
} as const satisfies Record<string, { bucket: string; maxBytes: number; mimes: Record<string, string> }>;

export type StorageKind = keyof typeof KINDS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^tenants\/([0-9a-f-]{36})\/(photo|logo|audio|qr|import)\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
};

// Pasta do disco local (só desenvolvimento): apps/api/.storage, fora do git.
const DEFAULT_LOCAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.storage");
let localNoticeLogged = false;

/** Mensagem de arquivo acima do limite; foto, logo e capa pedem uma imagem menor. */
export function tooBigMessage(kind: StorageKind, maxBytes: number): string {
  const mb = maxBytes / MB;
  return kind === "photo" || kind === "logo" ? `A imagem passa de ${mb} MB. Use uma imagem menor.` : "Arquivo vazio ou grande demais";
}

export function kindLimits(kind: StorageKind) {
  return KINDS[kind];
}

/** Recusa chave fora do formato (`..`, barras extras, outro prefixo); devolve o tipo e o restaurante. */
export function parseKey(key: string): { tenantId: string; kind: StorageKind } {
  const m = KEY.exec(key);
  if (!m || !UUID.test(m[1]!)) throw new BadRequestException("Chave de arquivo inválida");
  return { tenantId: m[1]!, kind: m[2] as StorageKind };
}

@Injectable()
export class StorageService {
  constructor(@Inject(ENV) private readonly env: Env) {
    if (this.isLocal() && !localNoticeLogged) {
      localNoticeLogged = true;
      new Logger("StorageService").log("storage: disco local (dev)");
    }
  }

  /** Sem as chaves do Supabase fora da produção, os arquivos ficam em disco; em produção continua o 503. */
  private isLocal(): boolean {
    return (!this.env.SUPABASE_URL || !this.env.SUPABASE_SECRET_KEY) && this.env.NODE_ENV !== "production";
  }

  private localDir(): string {
    return this.env.STORAGE_LOCAL_DIR ?? DEFAULT_LOCAL_DIR;
  }

  private localPath(bucket: string, key: string): string {
    parseKey(key);
    return path.join(this.localDir(), bucket, ...key.split("/"));
  }

  private localBase(): string {
    return `${this.env.WEB_ORIGIN.replace(/\/$/, "")}/api/storage`;
  }

  private localSignature(key: string, exp: number): string {
    const master = parseEncryptionKey(this.env.ENCRYPTION_KEY);
    const subkey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "dishdesk:storage-local-url", 32));
    return createHmac("sha256", subkey).update(`${key}.${exp}`).digest("hex");
  }

  /**
   * Leitura servida pelo StorageController no disco local. O bucket público não pede assinatura; o privado pede `exp` e `sig`
   * válidos. Chave fora do formato é 400; arquivo ausente, 404.
   */
  async localRead(bucket: string, key: string, exp?: string, sig?: string): Promise<{ bytes: Buffer; mime: string; isPublic: boolean }> {
    if (!this.isLocal()) throw new NotFoundException();
    const { kind } = parseKey(key);
    if (KINDS[kind].bucket !== bucket) throw new NotFoundException();
    const isPublic = bucket === PUBLIC_BUCKET;
    if (!isPublic) {
      const expiry = Number(exp);
      const expected = Buffer.from(Number.isInteger(expiry) ? this.localSignature(key, expiry) : "");
      const given = Buffer.from(sig ?? "");
      if (!Number.isInteger(expiry) || expected.length !== given.length || !timingSafeEqual(expected, given) || expiry * 1000 < Date.now()) {
        throw new ForbiddenException("Link inválido ou expirado");
      }
    }
    const bytes = await readFile(this.localPath(bucket, key)).catch(() => {
      throw new NotFoundException();
    });
    return { bytes, mime: MIME_BY_EXT[key.split(".").pop()!] ?? "application/octet-stream", isPublic };
  }

  private base(): { url: string; key: string } {
    const { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key } = this.env;
    if (!url || !key) throw new ServiceUnavailableException("Storage não configurado");
    return { url: url.replace(/\/$/, ""), key };
  }

  private async call(method: string, path: string, body?: string | Uint8Array<ArrayBuffer>, contentType = "application/json") {
    const { url, key } = this.base();
    const res = await fetch(`${url}/storage/v1${path}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": contentType },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Storage respondeu ${res.status}`);
    return res;
  }

  /** Valida tipo e tamanho e grava; devolve a chave (e a URL pública, quando o bucket é público). */
  async put(tenantId: string, kind: StorageKind, bytes: Uint8Array, mime: string): Promise<{ key: string; publicUrl: string | null }> {
    if (!UUID.test(tenantId)) throw new BadRequestException("Restaurante inválido");
    const spec = KINDS[kind];
    if (!spec) throw new BadRequestException("Tipo de arquivo inválido");
    const ext = (spec.mimes as Record<string, string>)[mime.split(";")[0]!.trim().toLowerCase()];
    if (!ext) throw new BadRequestException("Formato de arquivo não aceito");
    if (bytes.byteLength === 0) throw new BadRequestException("Arquivo vazio ou grande demais");
    if (bytes.byteLength > spec.maxBytes) throw new BadRequestException(tooBigMessage(kind, spec.maxBytes));
    const key = `tenants/${tenantId}/${kind}/${randomUUID()}.${ext}`;
    if (this.isLocal()) {
      const file = this.localPath(spec.bucket, key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return { key, publicUrl: spec.bucket === PUBLIC_BUCKET ? this.publicUrl(key) : null };
    }
    await this.call("POST", `/object/${spec.bucket}/${key}`, bytes as Uint8Array<ArrayBuffer>, mime);
    return { key, publicUrl: spec.bucket === PUBLIC_BUCKET ? this.publicUrl(key) : null };
  }

  publicUrl(key: string): string {
    parseKey(key);
    if (this.isLocal()) return `${this.localBase()}/${PUBLIC_BUCKET}/${key}`;
    return `${this.base().url}/storage/v1/object/public/${PUBLIC_BUCKET}/${key}`;
  }

  /** URL assinada para os arquivos privados (áudio, QR do Pix). */
  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const { kind } = parseKey(key);
    const bucket = KINDS[kind].bucket;
    if (this.isLocal()) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return `${this.localBase()}/${bucket}/${key}?exp=${exp}&sig=${this.localSignature(key, exp)}`;
    }
    const res = await this.call("POST", `/object/sign/${bucket}/${key}`, JSON.stringify({ expiresIn: ttlSeconds }));
    const { signedURL } = (await res.json()) as { signedURL: string };
    return `${this.base().url}/storage/v1${signedURL}`;
  }

  /** Baixa um arquivo privado, só se a chave for do restaurante informado. */
  async get(tenantId: string, key: string): Promise<Uint8Array> {
    const parsed = parseKey(key);
    if (parsed.tenantId !== tenantId) throw new BadRequestException("Chave de outro restaurante");
    if (this.isLocal()) {
      const bytes = await readFile(this.localPath(KINDS[parsed.kind].bucket, key)).catch(() => {
        throw new NotFoundException("Arquivo não encontrado");
      });
      return new Uint8Array(bytes);
    }
    const res = await this.call("GET", `/object/${KINDS[parsed.kind].bucket}/${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Apaga só se a chave for do restaurante informado. */
  async delete(tenantId: string, key: string): Promise<void> {
    const parsed = parseKey(key);
    if (parsed.tenantId !== tenantId) throw new BadRequestException("Chave de outro restaurante");
    if (this.isLocal()) {
      await rm(this.localPath(KINDS[parsed.kind].bucket, key), { force: true });
      return;
    }
    await this.call("DELETE", `/object/${KINDS[parsed.kind].bucket}/${key}`);
  }

  /** A chave de uma URL pública nossa, ou null (URL externa colada à mão). */
  keyFromPublicUrl(url: string | null): string | null {
    if (!url) return null;
    if (this.isLocal()) {
      const local = `${this.localBase()}/${PUBLIC_BUCKET}/`;
      return url.startsWith(local) ? url.slice(local.length) : null;
    }
    if (!this.env.SUPABASE_URL) return null;
    const prefix = `${this.env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${PUBLIC_BUCKET}/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }
}
