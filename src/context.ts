import { AsyncLocalStorage } from 'node:async_hooks';

import type { Baggage, BaggageEntry } from './baggage.js';
import { parse, serialize } from './baggage.js';

/**
 * A process may end up with both the CJS and the ESM build loaded — a NestJS
 * app importing the package while a `--require` preload also pulls it in, for
 * example. Two copies means two AsyncLocalStorage instances and silently empty
 * context, so the store is pinned to a global symbol and shared by both.
 */
const STATE_KEY = Symbol.for('mirrord-sdk.state.v1');

export interface SharedState {
  storage: AsyncLocalStorage<Baggage>;
  installed: boolean;
  instrumented: string[];
  uninstall: Array<() => void>;
}

interface GlobalWithState {
  [STATE_KEY]?: SharedState;
}

const globalRef = globalThis as GlobalWithState;

export const state: SharedState =
  globalRef[STATE_KEY] ||
  (globalRef[STATE_KEY] = {
    storage: new AsyncLocalStorage<Baggage>(),
    installed: false,
    instrumented: [],
    uninstall: [],
  });

/** The baggage attached to the current async context, if any. */
export function active(): Baggage | undefined {
  return state.storage.getStore();
}

/** Reads a single baggage value from the current context. */
export function get(key: string): string | undefined {
  const entry = state.storage.getStore()?.get(key);
  return entry ? entry.value : undefined;
}

/** Reads the current context as a plain object, for logging or assertions. */
export function getAll(): Record<string, string> {
  const out: Record<string, string> = {};
  const store = state.storage.getStore();
  if (store) for (const entry of store) out[entry[0]] = entry[1].value;
  return out;
}

/**
 * Writes a baggage value into the current context.
 *
 * Returns false when there is no active context — outside a request, there is
 * nothing to attach the value to and nowhere for it to propagate.
 */
export function set(key: string, value: string, properties?: string[]): boolean {
  const store = state.storage.getStore();
  if (!store) return false;
  const entry: BaggageEntry =
    properties && properties.length > 0 ? { value, properties } : { value };
  store.set(key, entry);
  return true;
}

/** Removes a baggage value from the current context. */
export function remove(key: string): boolean {
  const store = state.storage.getStore();
  return store ? store.delete(key) : false;
}

/** Serializes the current context into a `baggage` header value. */
export function currentHeader(): string {
  return serialize(state.storage.getStore());
}

/** Accepts anything that decodes into baggage: a header, a map, or an object. */
export type BaggageInput = Baggage | Record<string, string> | string | string[] | undefined | null;

function toBaggage(input: BaggageInput): Baggage {
  if (input == null) return new Map();
  if (input instanceof Map) return new Map(input);
  if (typeof input === 'string' || Array.isArray(input)) return parse(input);
  const out: Baggage = new Map();
  for (const key of Object.keys(input)) out.set(key, { value: String(input[key]) });
  return out;
}

/**
 * Runs `fn` with the given baggage attached to the async context.
 *
 * The context is copied, so mutations inside `fn` never leak back out to the
 * caller or sideways into a concurrently running request.
 */
export function runWith<T>(input: BaggageInput, fn: () => T): T {
  return state.storage.run(toBaggage(input), fn);
}

/**
 * Runs `fn` with the current baggage plus `additions`, leaving the caller's
 * context untouched.
 */
export function runWithAdded<T>(additions: Record<string, string>, fn: () => T): T {
  const next = new Map(state.storage.getStore() || []);
  for (const key of Object.keys(additions)) next.set(key, { value: String(additions[key]) });
  return state.storage.run(next, fn);
}

/** Binds `fn` to the baggage active right now, for callbacks that cross contexts. */
export function bind<F extends (...args: never[]) => unknown>(fn: F): F {
  const store = state.storage.getStore();
  if (!store) return fn;
  const snapshot = new Map(store);
  return function bound(this: unknown, ...args: never[]) {
    return state.storage.run(snapshot, () => fn.apply(this, args));
  } as F;
}
