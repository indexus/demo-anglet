// A record's payload as the SDK hands it: base64 text or JSON from a JSON
// /records answer (today), a Uint8Array view on the body from an IXRB answer
// (binary records, sdk "read /records as IXRB"). Bytes are read in place.

const utf8 = new TextDecoder();

/** The payload's bytes: the view itself when binary, decoded when base64 text. */
export function payloadBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string") throw Error("Record payload is neither bytes nor base64");
  const text = atob(value),
    out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** The payload as a JSON value: parsed text or bytes, or the object the SDK already parsed. */
export function payloadJson(value) {
  if (value instanceof Uint8Array) return JSON.parse(utf8.decode(value));
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * A record's payload as the readers want it: the bytes of a binary record
 * (IXRB view, or base64 text of a JSON answer that flags it binary), else the
 * JSON value.
 */
export function recordPayload(record) {
  return record.binary || record.payload instanceof Uint8Array ? payloadBytes(record.payload) : payloadJson(record.payload);
}

/** Bytes whose typed-array views can start anywhere on a 4-byte boundary (copied once when not). */
export function aligned(bytes) {
  return bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
}

/** The 4 characters a binary payload starts with. */
export const magic = (bytes) => String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
