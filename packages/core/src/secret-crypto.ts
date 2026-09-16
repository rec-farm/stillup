import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export type EncryptedSecret = { version: 1; iv: string; tag: string; ciphertext: string };
function keyBuffer(key: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Secret encryption key is unavailable');
  return Buffer.from(key, 'hex');
}
export function encryptSecret(name: string, value: string, key: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(key), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`StillUp secret v1:${name}`));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
export function decryptSecret(name: string, encrypted: EncryptedSecret, key: string): string {
  try {
    if (
      encrypted.version !== 1 ||
      Buffer.from(encrypted.iv, 'base64').length !== 12 ||
      Buffer.from(encrypted.tag, 'base64').length !== 16
    )
      throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyBuffer(key),
      Buffer.from(encrypted.iv, 'base64'),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(`StillUp secret v1:${name}`));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Stored secret cannot be decrypted');
  }
}
