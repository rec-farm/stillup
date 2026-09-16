import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from './secret-crypto';
import { secretReferences, secretCreateSchema } from './secrets';
import { webhookDestinationSchema } from './notifications';
const key = randomBytes(32).toString('hex');
it('encrypts each write with a unique nonce and authenticates names and contents', () => {
  const one = encryptSecret('TOKEN', 'sensitive-value', key);
  const two = encryptSecret('TOKEN', 'sensitive-value', key);
  expect(one.iv).not.toBe(two.iv);
  expect(JSON.stringify(one)).not.toContain('sensitive-value');
  expect(decryptSecret('TOKEN', one, key)).toBe('sensitive-value');
  expect(() => decryptSecret('OTHER', one, key)).toThrow('cannot be decrypted');
  expect(() => decryptSecret('TOKEN', one, randomBytes(32).toString('hex'))).toThrow(
    'cannot be decrypted',
  );
  for (const changed of [
    { ...one, ciphertext: Buffer.from('tampered').toString('base64') },
    { ...one, tag: Buffer.alloc(16).toString('base64') },
    { ...one, tag: Buffer.from(one.tag, 'base64').subarray(0, 4).toString('base64') },
    { ...one, iv: Buffer.alloc(8).toString('base64') },
  ])
    expect(() => decryptSecret('TOKEN', changed, key)).toThrow('cannot be decrypted');
});
it('extracts unique references and accepts whole webhook URL references', () => {
  expect(secretReferences(['Bearer {{TOKEN}}', '{{HOOK}}/{{TOKEN}}', 'plain'])).toEqual([
    'TOKEN',
    'HOOK',
  ]);
  expect(webhookDestinationSchema.parse('{{HOOK}}')).toBe('{{HOOK}}');
  expect(webhookDestinationSchema.parse('https://example.com/hook/{{TOKEN}}')).toContain(
    '{{TOKEN}}',
  );
});
it('rejects invalid managed names and empty values', () => {
  expect(secretCreateSchema.safeParse({ name: 'bad-name', value: 'abc' }).success).toBe(false);
  expect(secretCreateSchema.safeParse({ name: 'TOKEN', value: '' }).success).toBe(false);
});
