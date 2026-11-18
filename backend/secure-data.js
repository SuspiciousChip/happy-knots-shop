import crypto from 'node:crypto';

function keyFor(secret, purpose) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Encryption key material is too short');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('happy-knots-v1'), Buffer.from(purpose), 32));
}

export function encryptValue(value, secret, purpose) {
  if (typeof value !== 'string' || !value) throw new Error('A non-empty value is required');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptValue(value, secret, purpose) {
  const [version, iv, tag, ciphertext] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret, purpose), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
