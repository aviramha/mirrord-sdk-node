import type { Config } from '../config.js';
import { log } from '../config.js';
import { HEADER, outboundHeader } from '../outbound.js';

type FetchFn = (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;

function hostOf(input: unknown): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.hostname;
    const url = (input as { url?: unknown } | null)?.url;
    if (typeof url === 'string') return new URL(url).hostname;
  } catch {
    // A relative URL has no host to check; treat it as same-origin and allow.
  }
  return undefined;
}

/**
 * Wraps the global `fetch`.
 *
 * This is deliberately a wrapper rather than undici's `undici:request:create`
 * diagnostics channel: the channel only exists on Node builds that bundle
 * undici, while Bun and Deno ship their own fetch implementations. One wrapper
 * covers all three. Calls made through a directly imported `undici` are not
 * intercepted — use the exported `headers()` helper for those.
 */
export function installFetch(config: Config): Array<() => void> {
  const target = globalThis as { fetch?: FetchFn };
  const original = target.fetch;
  if (typeof original !== 'function') {
    log(config, 'no global fetch to instrument');
    return [];
  }

  const patched = function patchedFetch(
    this: unknown,
    input: unknown,
    init?: Record<string, unknown>,
  ) {
    // Everything that could fail happens before the call is made. The original
    // is then invoked exactly once, on either path, so a throwing fetch is
    // never retried by the error handler.
    let nextInit = init;
    try {
      const header = outboundHeader(config, hostOf(input));
      if (header !== null) {
        const headers = new Headers(
          (init && (init.headers as HeadersInit | undefined)) ||
            (input as { headers?: HeadersInit } | null)?.headers,
        );
        if (!headers.has(HEADER)) {
          headers.set(HEADER, header);
          // A Request as input carries its own immutable headers, so the merged
          // set has to be handed over through init, which takes precedence.
          nextInit = { ...(init || {}), headers };
        }
      }
    } catch {
      nextInit = init;
    }
    return original.call(this, input, nextInit);
  };

  target.fetch = patched;
  log(config, 'instrumented global fetch');

  return [
    () => {
      if (target.fetch === patched) target.fetch = original;
    },
  ];
}
