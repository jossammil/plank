// Unlocking a password-protected viewer: the data and the fields describing
// it were encrypted in R (see R/encrypt.R) and are decrypted here with the
// browser's WebCrypto. PBKDF2-SHA256 gives a key, split with HMAC into an
// encryption key and a MAC key; the MAC is checked before AES-256-CTR
// decryption, so a wrong password is reported as such.

import { decodeBase64 } from './load.js'

const MAC_PREFIX = 'pqview1'

export class WrongPassword extends Error {
  constructor() {
    super('Wrong password.')
    this.name = 'WrongPassword'
  }
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** WebCrypto, or null where the page is not secure (plain http). */
export const subtleCrypto = () => (globalThis.crypto && globalThis.crypto.subtle) || null

/**
 * Decrypts a protected payload.
 * @param {object} x the payload from R: { data, enc: { iter, salt, iv, mac } }
 * @param {string} password
 * @returns {Promise<{ fields: object, bytes: Uint8Array }>} the hidden payload fields and the parquet bytes
 */
export async function unlockPayload(x, password) {
  const subtle = subtleCrypto()
  if (!subtle) throw new Error('This page cannot decrypt data here: open the file directly, or from an https address.')
  const e = x.enc
  if (!e || e.v !== 1) throw new Error('This protected file needs a newer version of pqview.')
  const te = new TextEncoder()
  const salt = decodeBase64(e.salt)
  const iv = decodeBase64(e.iv)
  const mac = decodeBase64(e.mac)
  const ct = decodeBase64(x.data)
  const pw = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits'])
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: e.iter }, pw, 256)
  const split = await subtle.importKey('raw', master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const encRaw = await subtle.sign('HMAC', split, te.encode('pqview enc'))
  const macRaw = await subtle.sign('HMAC', split, te.encode('pqview mac'))
  const macKey = await subtle.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const ok = await subtle.verify('HMAC', macKey, mac, concat(te.encode(MAC_PREFIX), salt, iv, ct))
  if (!ok) throw new WrongPassword()
  const aes = await subtle.importKey('raw', encRaw, { name: 'AES-CTR' }, false, ['decrypt'])
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aes, ct))
  const n = ((plain[0] << 24) | (plain[1] << 16) | (plain[2] << 8) | plain[3]) >>> 0
  const fields = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n)))
  return { fields, bytes: plain.slice(4 + n) }
}
