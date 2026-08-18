export { MAX_MEMBERS, MAX_MEMBER_BYTES, MAX_TOTAL_BYTES, parse, serialize } from './baggage.js';
export type { Baggage, BaggageEntry } from './baggage.js';

export { hostAllowed, resolveConfig } from './config.js';
export type { Config, PropagateOptions } from './config.js';

export {
  active,
  bind,
  currentHeader,
  get,
  getAll,
  remove,
  runWith,
  runWithAdded,
  set,
} from './context.js';
export type { BaggageInput } from './context.js';

export { HEADER, outboundHeader } from './outbound.js';
