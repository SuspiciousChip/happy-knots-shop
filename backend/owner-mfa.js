import crypto from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(bytes) {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) output += BASE32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return output;
}

function decodeBase32(value) {
  const clean = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

export function totpCode(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 30000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(number).padStart(6, '0');
}

export function verifyTotp(secret, candidate, timestamp = Date.now()) {
  const supplied = String(candidate || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(supplied)) return false;
  return [-1, 0, 1].some(offset => crypto.timingSafeEqual(
    Buffer.from(totpCode(secret, timestamp + offset * 30000)), Buffer.from(supplied)));
}

export function totpUri(secret, email) {
  const label = encodeURIComponent(`Happy Knots:${String(email).toLowerCase()}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Happy Knots')}&algorithm=SHA1&digits=6&period=30`;
}
