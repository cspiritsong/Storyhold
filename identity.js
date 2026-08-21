/** Stable identity primitives shared by provenance, fingerprint, and idempotency code. */

export function hash32(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function canonicalMessage(message) {
  return JSON.stringify({
    name: String(message?.name ?? ''),
    is_user: Boolean(message?.is_user),
    is_system: Boolean(message?.is_system),
    mes: String(message?.mes ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\s+/g, ' ')
      .trim(),
  });
}
