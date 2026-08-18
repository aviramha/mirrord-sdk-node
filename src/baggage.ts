import { Buffer } from 'node:buffer';

/**
 * W3C Baggage codec.
 *
 * Grammar and limits follow the W3C Baggage recommendation:
 *   baggage-string = list-member 0*179( OWS "," OWS list-member )
 *   list-member    = key OWS "=" OWS value *( OWS ";" OWS property )
 *
 * @see https://www.w3.org/TR/baggage/
 */

/** Maximum number of list-members in a single baggage header. */
export const MAX_MEMBERS = 180;
/** Maximum length in bytes of a single list-member, including properties. */
export const MAX_MEMBER_BYTES = 4096;
/** Maximum total length in bytes of the serialized header. */
export const MAX_TOTAL_BYTES = 8192;

/** A single baggage entry: a value plus its opaque properties. */
export interface BaggageEntry {
  value: string;
  /** Opaque `;`-separated metadata, carried through verbatim. */
  properties?: string[];
}

/** A decoded baggage header. Insertion order is preserved on re-serialization. */
export type Baggage = Map<string, BaggageEntry>;

// RFC 7230 token characters, which is what a baggage key must be.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// The spec's limits are in bytes, and a baggage value may hold any UTF-8, so
// character length is not a substitute.
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Decodes a `baggage` header value.
 *
 * Takes the header exactly as it arrives on the wire. Node joins repeated
 * headers into one comma-separated string for everything except `set-cookie`,
 * which is also how the spec says multiple list-members are written, so there
 * is no array form to handle.
 *
 * Malformed list-members are skipped rather than failing the whole header, as
 * the spec requires a receiver to tolerate what it cannot understand. A header
 * over the total size limit is rejected outright.
 */
export function parse(header: string): Baggage {
  const decoded: Baggage = new Map();
  if (header === '' || byteLength(header) > MAX_TOTAL_BYTES) return decoded;

  const members = header.split(',');
  for (let i = 0; i < members.length; i++) {
    if (decoded.size >= MAX_MEMBERS) break;
    const member = members[i];
    if (byteLength(member) > MAX_MEMBER_BYTES) continue;

    const segments = member.split(';');
    const pair = segments[0];
    const separator = pair.indexOf('=');
    if (separator < 1) continue;

    const key = pair.slice(0, separator).trim();
    if (!TOKEN_RE.test(key)) continue;

    const encoded = pair.slice(separator + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      // A stray `%` that is not a valid escape. Keep the raw text rather than
      // dropping an entry a downstream service may still route on.
      value = encoded;
    }

    const properties: string[] = [];
    for (let p = 1; p < segments.length; p++) {
      const prop = segments[p].trim();
      if (prop !== '') properties.push(prop);
    }

    decoded.set(key, properties.length > 0 ? { value, properties } : { value });
  }
  return decoded;
}

/**
 * Encodes baggage into a header value, or `''` when there is nothing to send.
 *
 * Entries that would push the header past the spec's size limits are dropped
 * from the tail, so an oversized context degrades instead of producing a header
 * that a strict receiver would reject wholesale.
 */
export function serialize(baggage: Baggage | undefined | null): string {
  if (!baggage || baggage.size === 0) return '';
  const members: string[] = [];
  let totalBytes = 0;

  for (const entry of baggage) {
    if (members.length >= MAX_MEMBERS) break;
    const key = entry[0];
    // A caller can hand over a hand-built Map, so an entry is not guaranteed to
    // hold the shape the type claims. A bad one is skipped, exactly as a
    // malformed list-member is on the way in.
    if (entry[1] == null || typeof key !== 'string' || !TOKEN_RE.test(key)) continue;
    const { value, properties } = entry[1];
    if (value == null) continue;

    // encodeURIComponent only ever emits characters inside the baggage-octet
    // set, so its output is always a valid value.
    let member = key + '=' + encodeURIComponent(String(value));
    if (properties && properties.length > 0) member += ';' + properties.join(';');

    const memberBytes = byteLength(member);
    if (memberBytes > MAX_MEMBER_BYTES) continue;
    // The +1 is the comma this member needs if it is not the first.
    const withMember = totalBytes + memberBytes + (members.length > 0 ? 1 : 0);
    if (withMember > MAX_TOTAL_BYTES) break;

    members.push(member);
    totalBytes = withMember;
  }
  return members.join(',');
}
