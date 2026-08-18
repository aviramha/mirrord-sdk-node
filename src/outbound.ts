import type { Baggage } from './baggage.js';
import { serialize } from './baggage.js';
import type { Config } from './config.js';
import { hostAllowed } from './config.js';
import { active } from './context.js';

/** The canonical header name. Lowercase, per the W3C recommendation. */
export const HEADER = 'baggage';

/**
 * Builds the `baggage` header for an outbound call, or null when nothing
 * should be sent — no active context, an empty context, a host that is not
 * allowed to receive it, or every key filtered out.
 *
 * Never throws: a failure here would otherwise surface as a failed request in
 * application code that has nothing to do with propagation.
 */
export function outboundHeader(config: Config, host?: string): string | null {
  try {
    return buildHeader(config, host);
  } catch {
    return null;
  }
}

function buildHeader(config: Config, host?: string): string | null {
  const store = active();
  if (!store || store.size === 0) return null;
  if (!hostAllowed(config, host)) return null;

  let selected: Baggage = store;
  if (config.allowKeys) {
    selected = new Map();
    for (const entry of store) {
      if (config.allowKeys.indexOf(entry[0].toLowerCase()) !== -1) selected.set(entry[0], entry[1]);
    }
  }

  const header = serialize(selected);
  return header === '' ? null : header;
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
