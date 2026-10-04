/* Bencode, without loss.
 *
 * What a .torrent editor needs from a decoder is to give back what it was given: a key it has never
 * heard of, a name that is not valid UTF-8, an integer past 2^53. So byte strings stay Uint8Array,
 * dictionaries are Maps in the order the file has them, and an integer too big for a Number is a
 * BigInt. Keys are "binary strings": one character per byte (latin1), which compares and sorts the way
 * the bytes do, as bencode wants its keys sorted.
 *
 * Pure: no DOM, nothing but crypto.subtle for the hash, so it runs in Node for the tests too.
 */

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();
const MAX_DEPTH = 128;

/** Bytes that are written out exactly as they are: an `info` dictionary nothing was changed in. */
export class Raw {
  constructor(bytes) { this.bytes = bytes; }
}

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};
const fromLatin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A byte string as text: UTF-8 when it is that, and as many characters as bytes when it is not. */
export function text(value) {
  if (typeof value === 'string') return value;
  if (!(value instanceof Uint8Array)) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return latin1(value);
  }
}

/** A key as it reads, for showing it (keys are kept one character per byte). */
export function keyText(key) {
  return text(fromLatin1(key));
}

export const bytesOf = (s) => utf8.encode(s);

/**
 * Decode bencoded bytes. With `{ spans: true }` the answer is `{ value, spans }`, where `spans` maps each
 * key of the top-level dictionary to the [start, end) of its value's bytes: what is hashed for `info`.
 */
export function decode(bytes, { spans: wantSpans = false } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  let pos = 0;
  const spans = new Map();
  const fail = (why) => { throw new Error(`not valid bencode: ${why} at byte ${pos}`); };

  function digits(end) {
    const s = utf8Decoder.decode(bytes.subarray(pos, end));
    if (!/^-?\d+$/.test(s)) fail('a number expected');
    return s;
  }

  function read(depth) {
    if (depth > MAX_DEPTH) fail('nested too deep');
    if (pos >= bytes.length) fail('unexpected end');
    const c = bytes[pos];
    if (c === 0x69) { // i<int>e
      const end = bytes.indexOf(0x65, pos + 1);
      if (end < 0) fail('unterminated integer');
      pos += 1;
      const s = digits(end);
      pos = end + 1;
      const n = Number(s);
      return Number.isSafeInteger(n) ? n : BigInt(s);
    }
    if (c === 0x6c) { // l…e
      pos += 1;
      const out = [];
      while (bytes[pos] !== 0x65) {
        if (pos >= bytes.length) fail('unterminated list');
        out.push(read(depth + 1));
      }
      pos += 1;
      return out;
    }
    if (c === 0x64) { // d…e
      pos += 1;
      const out = new Map();
      const top = depth === 0;
      while (bytes[pos] !== 0x65) {
        if (pos >= bytes.length) fail('unterminated dictionary');
        if (bytes[pos] < 0x30 || bytes[pos] > 0x39) fail('a key must be a byte string');
        const key = latin1(read(depth + 1));
        const start = pos;
        const value = read(depth + 1);
        // A second value for the same key: which one a client takes is anyone's guess, so neither is.
        if (out.has(key)) fail(`duplicate key "${keyText(key)}"`);
        out.set(key, value);
        if (top) spans.set(key, [start, pos]);
      }
      pos += 1;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = bytes.indexOf(0x3a, pos);
      if (colon < 0) fail('a byte string without its colon');
      const len = Number(digits(colon));
      const start = colon + 1;
      if (len < 0 || start + len > bytes.length) fail('a byte string longer than what is left');
      pos = start + len;
      return bytes.slice(start, pos);
    }
    return fail(`unexpected "${String.fromCharCode(c)}"`);
  }

  const value = read(0);
  if (pos !== bytes.length) fail('bytes after the end');
  return wantSpans ? { value, spans } : value;
}

/**
 * Encode a value. Maps and plain objects are dictionaries, their keys sorted; a string is written as
 * its UTF-8 bytes (a key, one byte per character — see above); a Raw is written as it is.
 */
export function encode(value) {
  const parts = [];
  let size = 0;
  const push = (b) => { parts.push(b); size += b.length; };
  const ascii = (s) => push(utf8.encode(s));

  function write(v) {
    if (v instanceof Raw) return push(v.bytes);
    if (v instanceof Uint8Array) {
      ascii(`${v.length}:`);
      return push(v);
    }
    if (ArrayBuffer.isView(v)) return write(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (typeof v === 'string') return write(utf8.encode(v));
    if (typeof v === 'boolean') return ascii(`i${v ? 1 : 0}e`);
    if (typeof v === 'bigint') return ascii(`i${v}e`);
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error(`bencode has no fractions: ${v}`);
      return ascii(`i${v}e`);
    }
    if (Array.isArray(v)) {
      ascii('l');
      for (const item of v) if (item !== undefined && item !== null) write(item);
      return ascii('e');
    }
    if (v instanceof Map || (v && typeof v === 'object')) {
      const entries = (v instanceof Map ? [...v] : Object.entries(v)).filter(([, x]) => x !== undefined && x !== null);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      ascii('d');
      for (const [k, x] of entries) {
        const key = fromLatin1(k);
        ascii(`${key.length}:`);
        push(key);
        write(x);
      }
      return ascii('e');
    }
    throw new Error(`cannot bencode ${typeof v}`);
  }

  write(value);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha1(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
}

/** The v1 info hash of a .torrent, in lower-case hexadecimal: the SHA-1 of its `info` value's bytes. */
export async function infoHashOf(bytes) {
  const { spans } = decode(bytes, { spans: true });
  const span = spans.get('info');
  if (!span) throw new Error('not a .torrent file: it has no info dictionary');
  return hex(await sha1(bytes.subarray(span[0], span[1])));
}
