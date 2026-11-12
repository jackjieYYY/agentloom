import { expect, it } from 'vitest';
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from 'jose';
import { decryptApiKey, encryptApiKey } from '../src/models/credentials.js';

it('stores authenticated JWE with random IVs and binds credentials to the provider', async () => {
  const key = 'ab'.repeat(32);
  const first = await encryptApiKey('private-api-key', key, 'provider');
  const second = await encryptApiKey('private-api-key', key, 'provider');
  expect(first).not.toBe(second);
  expect(first).not.toContain('private-api-key');
  expect(first.split('.')).toHaveLength(5);
  expect(decodeProtectedHeader(first)).toEqual({
    alg: 'dir',
    enc: 'A256GCM',
    providerId: 'provider',
  });
  const { plaintext } = await compactDecrypt(first, Buffer.from(key, 'hex'));
  expect(new TextDecoder().decode(plaintext)).toBe('private-api-key');
  await expect(decryptApiKey(first, key, 'provider')).resolves.toBe(
    'private-api-key',
  );
  const parts = first.split('.');
  const changedHeader = Buffer.from(
    JSON.stringify({ alg: 'dir', enc: 'A256GCM', providerId: 'other' }),
  ).toString('base64url');
  const changedCiphertext = Buffer.from(parts[3], 'base64url');
  changedCiphertext[0] ^= 1;
  for (const [ciphertext, secret, provider] of [
    [first, key, 'other'],
    [first, 'cd'.repeat(32), 'provider'],
    [first, undefined, 'provider'],
    [[changedHeader, ...parts.slice(1)].join('.'), key, 'other'],
    [
      [
        ...parts.slice(0, 3),
        changedCiphertext.toString('base64url'),
        parts[4],
      ].join('.'),
      key,
      'provider',
    ],
    [first.slice(0, -4), key, 'provider'],
    ['v1.nonce.tag.ciphertext', key, 'provider'],
  ]) {
    await expect(decryptApiKey(ciphertext!, secret, provider!)).rejects.toThrow(
      'Model configuration unavailable',
    );
  }
});

it('rejects missing bindings and unapproved JWE algorithms', async () => {
  const key = 'ab'.repeat(32);
  for (const header of [
    { alg: 'A256KW', enc: 'A256GCM', providerId: 'provider' },
    { alg: 'dir', enc: 'A128CBC-HS256', providerId: 'provider' },
    { alg: 'dir', enc: 'A256GCM' },
  ]) {
    const token = await new CompactEncrypt(
      new TextEncoder().encode('private-api-key'),
    )
      .setProtectedHeader(header)
      .encrypt(Buffer.from(key, 'hex'));
    await expect(decryptApiKey(token, key, 'provider')).rejects.toThrow(
      'Model configuration unavailable',
    );
  }
});
