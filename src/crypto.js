import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const encryptionKeyFile = process.env.CONFIG_ENCRYPTION_KEY_FILE || "";
let encryptionSecret = process.env.CONFIG_ENCRYPTION_KEY || "";
if (encryptionKeyFile) {
  try {
    const fileVal = readFileSync(encryptionKeyFile, "utf8").trim();
    if (fileVal) encryptionSecret = fileVal;
  } catch {
    // fall back to env var
  }
}

export function encryptPassword(password) {
  if (!password) return "";
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(password), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptPassword(ciphertext) {
  if (!ciphertext) return "";
  try {
    const [version, iv, tag, encrypted] = String(ciphertext).split(":");
    if (version !== "v1" || !iv || !tag || !encrypted) return "";
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function encryptionKey() {
  if (!encryptionSecret) {
    throw new Error("CONFIG_ENCRYPTION_KEY is required before storing Pi-hole passwords");
  }
  const decoded = Buffer.from(encryptionSecret, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(encryptionSecret).digest();
}
