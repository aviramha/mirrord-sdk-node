import http from 'node:http';
import https from 'node:https';

import { HEADER, findHeader, outboundHeader } from '../outbound.js';

type RequestFn = (...args: unknown[]) => unknown;
type HttpModule = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Injects the header into a `node:http` call site.
 *
 * The argument list is one of `(options[, cb])`, `(url[, cb])` or
 * `(url, options[, cb])`. Options are shallow-copied rather than mutated,
 * because callers routinely reuse a single options object across requests and
 * would otherwise accumulate a stale header from whichever context ran first.
 */
function injectIntoArgs(args: unknown[]): unknown[] {
  let index = -1;

  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    if (isPlainObject(args[1])) index = 1;
  } else if (isPlainObject(args[0])) {
    index = 0;
  }

  const source = index === -1 ? undefined : (args[index] as Record<string, unknown>);
  // Copied rather than mutated: callers reuse a single options object across
  // requests, and an in-place header would pin the first request's context onto
  // every later one. The prototype is carried over for callers that pass a
  // class instance rather than an object literal.
  const options: Record<string, unknown> = source
    ? Object.assign(Object.create(Object.getPrototypeOf(source) as object | null), source)
    : {};
  const header = outboundHeader();
  if (header === null) return args;

  const headers: Record<string, unknown> = isPlainObject(options.headers)
    ? { ...options.headers }
    : {};
  // An explicit header set by the caller wins; they know something we do not.
  if (findHeader(headers, HEADER) !== undefined) return args;
  headers[HEADER] = header;
  options.headers = headers;

  const next = args.slice();
  if (index === -1) {
    // `(url, cb)` — splice an options object in between.
    next.splice(1, 0, options);
  } else {
    next[index] = options;
  }
  return next;
}

/**
 * `http.get` calls the module-local `request` binding rather than the exported
 * one, so both have to be wrapped. The already-set check in `injectIntoArgs`
 * makes the resulting double pass a no-op.
 */
function patchModule(mod: HttpModule): Array<() => void> {
  const undo: Array<() => void> = [];
  for (const name of ['request', 'get']) {
    const original = mod[name];
    if (typeof original !== 'function') continue;
    const fn = original as RequestFn;
    const wrapped = function patched(this: unknown, ...args: unknown[]) {
      let nextArgs = args;
      try {
        nextArgs = injectIntoArgs(args);
      } catch {
        // Fall back to exactly what the caller passed.
        nextArgs = args;
      }
      return fn.apply(this, nextArgs);
    };
    Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
    mod[name] = wrapped;
    undo.push(() => {
      mod[name] = original;
    });
  }
  return undo;
}

export function installHttpClient(): Array<() => void> {
  return [...patchModule(http), ...patchModule(https)];
}
