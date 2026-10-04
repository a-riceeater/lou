const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number, length: number): string {
  let out = "";
  let value = ms;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out;
}

/**
 * Time-sortable, prefixed identifier (ULID layout: 10 chars time + 16 chars random).
 * Example: `run_01J9Z3K7Q4N8W2X5Y6Z7A8B9C0`.
 */
export function newId(prefix: string): string {
  return `${prefix}_${encodeTime(Date.now(), 10)}${encodeRandom(16)}`.toLowerCase();
}

/** Short human-enterable code such as a device pairing code: `ABCD-EFGH`. */
export function newPairingCode(): string {
  const raw = encodeRandom(8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
