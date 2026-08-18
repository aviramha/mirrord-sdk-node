import {
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
import { auto_propagate, is_propagating, stop_propagate } from './install.js';

export { MAX_MEMBERS, MAX_MEMBER_BYTES, MAX_TOTAL_BYTES, parse, serialize } from './baggage.js';
export type { Baggage, BaggageEntry } from './baggage.js';

export type { PropagateOptions } from './config.js';

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

export { HEADER } from './outbound.js';

export { auto_propagate, is_propagating, stop_propagate } from './install.js';
export type { PropagateHandle } from './install.js';

/**
 * camelCase alias for {@link auto_propagate}, for codebases that would rather
 * not have a snake_case call in the middle of an entry point.
 */
export const autoPropagate = auto_propagate;

/** Default export, so `import mirrord from 'mirrord-sdk'` reads naturally. */
const mirrord = {
  auto_propagate,
  autoPropagate,
  stop_propagate,
  is_propagating,
  get,
  getAll,
  set,
  remove,
  active,
  currentHeader,
  runWith,
  runWithAdded,
  bind,
};

export default mirrord;
