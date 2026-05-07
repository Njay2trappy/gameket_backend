import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const STANDARD_IV_BYTES = 12;

const isHex = (value: string): boolean => /^[0-9a-fA-F]+$/.test(value);

const getEncryptionKey = (): Buffer => {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("Server configuration error");
  }

  const keyBuffer = Buffer.from(encryptionKey, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error("Server configuration error");
  }

  return keyBuffer;
};

const parseEncryptedPayload = (value: string): { ivHex: string; authTagHex: string; ciphertext: string } | null => {
  const parts = value.split(":");
  if (parts.length !== 3) {
    return null;
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  if (
    !ivHex ||
    !authTagHex ||
    !ciphertext ||
    ![24, 32].includes(ivHex.length) ||
    authTagHex.length !== 32 ||
    ciphertext.length % 2 !== 0 ||
    ivHex.length % 2 !== 0 ||
    authTagHex.length % 2 !== 0 ||
    !isHex(ivHex) ||
    !isHex(authTagHex) ||
    !isHex(ciphertext)
  ) {
    return null;
  }

  return { ivHex, authTagHex, ciphertext };
};

export function encryptCode(text: string): string {
  const iv = crypto.randomBytes(STANDARD_IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptCode(value: string): string {
  const payload = parseEncryptedPayload(value);
  if (!payload) {
    throw new Error("Invalid encrypted payload");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(payload.ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(payload.authTagHex, "hex"));
  let decrypted = decipher.update(payload.ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function decryptCodeOrPlain(value: string): string {
  const payload = parseEncryptedPayload(value);
  if (!payload) {
    return value;
  }

  try {
    return decryptCode(value);
  } catch {
    return value;
  }
}
