import { HEADER, outboundHeader } from '../outbound.js';

type FetchFn = (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;
type HeadersArg = ConstructorParameters<typeof Headers>[0];

/**
 * Wraps the global `fetch`.
 *
 * This is deliberately a wrapper rather than undici's `undici:request:create`
 * diagnostics channel: the channel only exists on Node builds that bundle
 * undici, while Bun and Deno ship their own fetch implementations. One wrapper
 * covers all three. Calls made through a directly imported `undici` are not
 * intercepted — use the exported `currentHeader()` helper for those.
 */
export function installFetch(): Array<() => void> {
  const target = globalThis as { fetch?: FetchFn };
  const original = target.fetch;
  if (typeof original !== 'function') return [];

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
      const header = outboundHeader();
      if (header !== null) {
        const headers = new Headers(
          (init && (init.headers as HeadersArg)) ||
            (input as { headers?: HeadersArg } | null)?.headers,
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

  return [
    () => {
      if (target.fetch === patched) target.fetch = original;
    },
  ];
}
