import crypto from 'node:crypto';
import { env } from './env.js';

const VERSION = 1;
const AAD = Buffer.from('n-sktorrent-streamio-ad:config:v1', 'utf8');
const MAX_TOKEN_LENGTH = 4096;

function key() {
  if (!configEncryptionReady()) throw new Error('CONFIG_SECRET is not configured');
  return crypto.createHash('sha256').update(env.configSecret, 'utf8').digest();
}

export function configEncryptionReady() {
  return typeof env.configSecret === 'string' && env.configSecret.length >= 24;
}

export function encryptConfig(config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(AAD);

  const payload = Buffer.from(JSON.stringify({
    sktUid: String(config.sktUid || '').trim(),
    sktPass: String(config.sktPass || '').trim(),
    torboxKey: String(config.torboxKey || '').trim(),
    tmdbKey: String(config.tmdbKey || '').trim()
  }), 'utf8');

  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString('base64url');
}

export function decryptConfig(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > MAX_TOKEN_LENGTH) {
    throw new Error('Invalid configuration token');
  }

  let packed;
  try {
    packed = Buffer.from(token, 'base64url');
  } catch {
    throw new Error('Invalid configuration token');
  }

  if (packed.length < 30 || packed[0] !== VERSION) throw new Error('Unsupported configuration token');

  const iv = packed.subarray(1, 13);
  const tag = packed.subarray(13, 29);
  const ciphertext = packed.subarray(29);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    return {
      sktUid: String(parsed?.sktUid || '').trim(),
      sktPass: String(parsed?.sktPass || '').trim(),
      torboxKey: String(parsed?.torboxKey || '').trim(),
      tmdbKey: String(parsed?.tmdbKey || '').trim()
    };
  } catch {
    throw new Error('Invalid or expired configuration token');
  }
}
