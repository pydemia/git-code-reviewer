import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type EncryptedCredential = {
  credentialCiphertext: Buffer;
  credentialIv: Buffer;
  credentialAuthTag: Buffer;
};

export function encryptCredential(
  value: string,
  encodedKey: string | undefined,
  purpose: string,
): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encodedKey), iv);
  cipher.setAAD(Buffer.from(`git-code-reviewer:${purpose}:v1`, 'utf8'));
  const credentialCiphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    credentialCiphertext,
    credentialIv: iv,
    credentialAuthTag: cipher.getAuthTag(),
  };
}

export function decryptCredential(
  encrypted: EncryptedCredential,
  encodedKey: string | undefined,
  purpose: string,
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(encodedKey),
    encrypted.credentialIv,
  );
  decipher.setAAD(Buffer.from(`git-code-reviewer:${purpose}:v1`, 'utf8'));
  decipher.setAuthTag(encrypted.credentialAuthTag);
  return Buffer.concat([
    decipher.update(encrypted.credentialCiphertext),
    decipher.final(),
  ]).toString('utf8');
}

export function credentialFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validCredentialEncryptionKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return Buffer.from(value, 'base64').byteLength === 32;
  } catch {
    return false;
  }
}

function encryptionKey(value: string | undefined): Buffer {
  if (!validCredentialEncryptionKey(value)) {
    throw new Error('Credential encryption key must be a base64 encoded 32-byte value');
  }
  return Buffer.from(value!, 'base64');
}
