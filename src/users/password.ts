import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

const parameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function deriveKey(password: string, salt: Buffer, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, parameters);
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, N, r, p, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt') throw new Error('Unsupported password algorithm');
  const key = await deriveKey(password, Buffer.from(salt, 'hex'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: parameters.maxmem,
  });
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
