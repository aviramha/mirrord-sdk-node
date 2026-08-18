import { serialize } from './baggage.js';
import { active } from './context.js';

/** The canonical header name. Lowercase, per the W3C recommendation. */
export const HEADER = 'baggage';

/**
 * Builds the `baggage` header for an outbound call, or null when there is
 * nothing to send.
 *
 * Never throws: a failure here would otherwise surface as a failed request in
 * application code that has nothing to do with propagation.
 */
export function outboundHeader(): string | null {
  try {
    const store = active();
    if (!store || store.size === 0) return null;
    const header = serialize(store);
    return header === '' ? null : header;
  } catch {
    return null;
  }
}

/** Case-insensitive lookup over a plain headers object. */
export function findHeader(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (Object.prototype.hasOwnProperty.call(headers, name)) return name;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}
