import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, LouError } from "@lou/shared";

/**
 * Encrypted-at-rest secret storage using AES-256-GCM with a master key from the
 * environment. Ciphertext format: `v1.<iv>.<tag>.<data>` (base64url parts).
 */
export class Vault {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    const key = Buffer.from(masterKeyBase64, "base64");
    if (key.length !== 32) throw new Error("LOU_MASTER_KEY must decode to exactly 32 bytes");
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  }

  decrypt(ciphertext: string): string {
    const [version, iv, tag, data] = ciphertext.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new LouError("INTERNAL", "Unrecognized secret format");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch (err) {
      throw new LouError("INTERNAL", "Failed to decrypt secret (wrong LOU_MASTER_KEY?)", { cause: err });
    }
  }

  encryptOptional(value: string | null | undefined): string | null {
    return value ? this.encrypt(value) : null;
  }
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash of the canonical JSON of a value; used to bind approvals to exact actions. */
export function hashAction(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hmacBase64(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("base64");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
