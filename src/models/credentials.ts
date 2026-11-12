import { CompactEncrypt, compactDecrypt } from 'jose';
import { AppError } from '../runtime/app-error.js';

function keyBytes(key: string | undefined) {
  if (!key) throw new Error('Model credentials unavailable');
  return Buffer.from(key, 'hex');
}

export async function encryptApiKey(
  value: string,
  key: string | undefined,
  providerId: string,
) {
  try {
    // The protected header authenticates the provider binding along with the ciphertext.
    return await new CompactEncrypt(new TextEncoder().encode(value))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', providerId })
      .encrypt(keyBytes(key));
  } catch {
    throw new AppError(503, 'Model configuration unavailable');
  }
}

export async function decryptApiKey(
  value: string,
  key: string | undefined,
  providerId: string,
) {
  try {
    const { plaintext, protectedHeader } = await compactDecrypt(
      value,
      keyBytes(key),
      {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
      },
    );
    if (protectedHeader.providerId !== providerId) throw new Error();
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new AppError(503, 'Model configuration unavailable');
  }
}
